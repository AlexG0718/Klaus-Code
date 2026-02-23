import * as fs from 'fs-extra';
import * as path from 'path';
import fg from 'fast-glob';
import { applyPatch, createPatch } from 'diff';
import { logger } from '../logger';
import type {
  ReadFileInput,
  WriteFileInput,
  ApplyPatchInput,
  DeleteFileInput,
  ListFilesInput,
  SearchFilesInput,
} from './schemas';

// Paths the agent can NEVER access, even if workspace contains them
const ALWAYS_BLOCKED = [
  '/etc', '/usr', '/bin', '/sbin', '/boot', '/sys', '/proc',
  '/dev', '/root', '/private/etc', '/private/var/root',
];

export class FileTool {
  private readonly resolvedWorkspace: string;
  private agentIgnorePatterns: string[] = [];
  private agentIgnoreLoadedAt = 0;

  constructor(private readonly workspaceDir: string) {
    this.resolvedWorkspace = path.resolve(workspaceDir);
  }

  /**
   * Load .agentignore from the workspace root. Patterns are gitignore-style.
   * Re-reads at most once per second to pick up edits without restarting.
   */
  private loadAgentIgnore(): void {
    const now = Date.now();
    if (now - this.agentIgnoreLoadedAt < 1000) return;
    this.agentIgnoreLoadedAt = now;

    const ignorePath = path.join(this.resolvedWorkspace, '.agentignore');
    try {
      const content = fs.readFileSync(ignorePath, 'utf8');
      this.agentIgnorePatterns = content
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
      logger.debug('.agentignore loaded', { patterns: this.agentIgnorePatterns });
    } catch {
      this.agentIgnorePatterns = [];
    }
  }

  /**
   * Returns true if the given relative path matches any .agentignore pattern.
   * Supports exact matches, directory prefixes, and simple glob wildcards.
   */
  private isIgnored(relativePath: string): boolean {
    this.loadAgentIgnore();
    if (this.agentIgnorePatterns.length === 0) return false;

    for (const pattern of this.agentIgnorePatterns) {
      // Exact match or path starts with a directory pattern
      if (relativePath === pattern) return true;
      if (relativePath.startsWith(pattern + '/')) return true;
      // Simple wildcard: *.env, .env*, secrets/**
      const regexStr = pattern
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '.+')
        .replace(/\*/g, '[^/]+');
      if (new RegExp(`^${regexStr}$`).test(relativePath)) return true;
    }
    return false;
  }

  private assertNotIgnored(resolvedPath: string, operation: string): void {
    const relative = path.relative(this.resolvedWorkspace, resolvedPath);
    if (this.isIgnored(relative)) {
      logger.warn('.agentignore blocked operation', { operation, path: relative });
      throw new Error(
        `Access denied: "${relative}" is listed in .agentignore and cannot be ${operation} by the agent.`
      );
    }
  }

  /**
   * Resolves a file path and ENFORCES it stays inside the workspace.
   * Throws if the resolved path escapes the workspace directory or hits a
   * blocked system path — regardless of whether the input used `../`, absolute
   * paths, symlinks in the name, or any other traversal technique.
   */
  private resolvePath(filePath: string): string {
    // Strip leading slashes so "/etc/passwd" becomes "etc/passwd" relative to workspace
    const sanitized = filePath.replace(/^[/\\]+/, '');

    // Resolve relative to workspace
    const resolved = path.resolve(this.resolvedWorkspace, sanitized);

    // Enforce containment: resolved path must start with workspace + separator
    const workspacePrefix = this.resolvedWorkspace.endsWith(path.sep)
      ? this.resolvedWorkspace
      : this.resolvedWorkspace + path.sep;

    const isConfined =
      resolved === this.resolvedWorkspace ||
      resolved.startsWith(workspacePrefix);

    if (!isConfined) {
      logger.error('Path traversal attempt blocked', {
        requested: filePath,
        resolved,
        workspace: this.resolvedWorkspace,
      });
      throw new Error(
        `Access denied: "${filePath}" resolves outside the workspace directory. ` +
        `All file operations must stay within: ${this.resolvedWorkspace}`
      );
    }

    // Secondary check: block known sensitive system paths
    for (const blocked of ALWAYS_BLOCKED) {
      if (resolved.startsWith(blocked)) {
        logger.error('Blocked system path access attempt', { resolved, blocked });
        throw new Error(
          `Access denied: "${resolved}" is a protected system path and cannot be accessed.`
        );
      }
    }

    return resolved;
  }

  async readFile(input: ReadFileInput): Promise<{ content: string; size: number; path: string }> {
    const resolvedPath = this.resolvePath(input.path);
    this.assertNotIgnored(resolvedPath, 'read');
    logger.debug('Reading file', { path: resolvedPath });

    if (!(await fs.pathExists(resolvedPath))) {
      throw new Error(`File not found: ${resolvedPath}`);
    }

    const stat = await fs.stat(resolvedPath);
    if (stat.size > 10 * 1024 * 1024) {
      throw new Error(`File too large: ${resolvedPath} (${stat.size} bytes). Max 10MB.`);
    }

    const content = await fs.readFile(resolvedPath, input.encoding as BufferEncoding);
    logger.debug('File read complete', { path: resolvedPath, size: stat.size });
    return { content, size: stat.size, path: resolvedPath };
  }

  async writeFile(input: WriteFileInput): Promise<{ path: string; size: number }> {
    const resolvedPath = this.resolvePath(input.path);
    this.assertNotIgnored(resolvedPath, 'written');
    logger.info('Writing file', { path: resolvedPath });

    if (input.createDirs) {
      await fs.ensureDir(path.dirname(resolvedPath));
    }

    await fs.writeFile(resolvedPath, input.content, 'utf8');
    const stat = await fs.stat(resolvedPath);
    logger.info('File written', { path: resolvedPath, size: stat.size });
    return { path: resolvedPath, size: stat.size };
  }

  async applyPatch(input: ApplyPatchInput): Promise<{ path: string; success: boolean; result: string }> {
    const resolvedPath = this.resolvePath(input.path);
    this.assertNotIgnored(resolvedPath, 'modified');
    logger.info('Applying patch', { path: resolvedPath });

    let originalContent = '';
    if (await fs.pathExists(resolvedPath)) {
      originalContent = await fs.readFile(resolvedPath, 'utf8');
    }

    const patched = applyPatch(originalContent, input.patch);
    if (patched === false) {
      logger.error('Patch application failed', { path: resolvedPath });
      throw new Error(`Failed to apply patch to ${resolvedPath}. Patch may be invalid or context doesn't match.`);
    }

    await fs.ensureDir(path.dirname(resolvedPath));
    await fs.writeFile(resolvedPath, patched, 'utf8');
    logger.info('Patch applied successfully', { path: resolvedPath });
    return { path: resolvedPath, success: true, result: patched };
  }

  async createPatch(filePath: string, newContent: string): Promise<string> {
    const resolvedPath = this.resolvePath(filePath);
    const originalContent = (await fs.pathExists(resolvedPath))
      ? await fs.readFile(resolvedPath, 'utf8')
      : '';
    return createPatch(filePath, originalContent, newContent);
  }

  async deleteFile(input: DeleteFileInput): Promise<{ path: string }> {
    const resolvedPath = this.resolvePath(input.path);
    this.assertNotIgnored(resolvedPath, 'deleted');
    logger.info('Deleting file', { path: resolvedPath });
    await fs.remove(resolvedPath);
    logger.info('File deleted', { path: resolvedPath });
    return { path: resolvedPath };
  }

  async listFiles(input: ListFilesInput): Promise<string[]> {
    const resolvedDir = this.resolvePath(input.directory);
    logger.debug('Listing files', { directory: resolvedDir, pattern: input.pattern });

    const files = await fg(input.pattern, {
      cwd: resolvedDir,
      ignore: input.ignore,
      deep: input.maxDepth,
      onlyFiles: false,
      dot: false,
    });

    logger.debug('Files listed', { count: files.length });
    return files;
  }

  async searchInFiles(
    input: SearchFilesInput,
    maxResults: number = 500
  ): Promise<{ matches: Array<{ file: string; line: number; content: string }>; truncated: boolean }> {
    const resolvedDir = this.resolvePath(input.directory);
    logger.debug('Searching files', { directory: resolvedDir, pattern: input.pattern, maxResults });

    const files = await fg(input.fileGlob, {
      cwd: resolvedDir,
      ignore: ['node_modules/**', '.git/**', 'dist/**'],
    });

    const results: Array<{ file: string; line: number; content: string }> = [];
    // Use non-global regex for per-line test — avoids lastIndex state issues with 'gi' flag
    const regex = new RegExp(input.pattern, 'i');
    let truncated = false;

    outer: for (const file of files) {
      const fullPath = path.join(resolvedDir, file);
      try {
        const content = await fs.readFile(fullPath, 'utf8');
        const lines = content.split('\n');
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index];
          if (regex.test(line)) {
            results.push({ file, line: index + 1, content: line.trim() });
            // Cap results to prevent unbounded memory/context window usage
            if (results.length >= maxResults) {
              truncated = true;
              logger.warn('Search results truncated', { maxResults, file, pattern: input.pattern });
              break outer;
            }
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    logger.debug('Search complete', { matches: results.length, truncated });
    return { matches: results, truncated };
  }
}
