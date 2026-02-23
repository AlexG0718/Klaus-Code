import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import { FileTool } from '../../tools/FileTool';

describe('FileTool - Unit Tests', () => {
  let workspace: string;
  let fileTool: FileTool;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-file-test-'));
    fileTool = new FileTool(workspace);
  });

  afterEach(async () => {
    await fs.remove(workspace);
  });

  // ── Workspace Confinement ────────────────────────────────────────────────

  describe('Workspace confinement (security)', () => {
    it('should block path traversal via ../', async () => {
      await expect(
        fileTool.readFile({ path: '../../etc/passwd', encoding: 'utf8' })
      ).rejects.toThrow('Access denied');
    });

    it('should block absolute paths outside workspace', async () => {
      await expect(
        fileTool.readFile({ path: '/etc/passwd', encoding: 'utf8' })
      ).rejects.toThrow('Access denied');
    });

    it('should block deeply nested traversal', async () => {
      await expect(
        fileTool.readFile({ path: 'src/../../../etc/shadow', encoding: 'utf8' })
      ).rejects.toThrow('Access denied');
    });

    it('should block writes outside workspace', async () => {
      await expect(
        fileTool.writeFile({ path: '../outside-workspace.ts', content: 'evil', createDirs: false })
      ).rejects.toThrow('Access denied');
    });

    it('should block deletes outside workspace', async () => {
      await expect(
        fileTool.deleteFile({ path: '../../important-file' })
      ).rejects.toThrow('Access denied');
    });

    it('should allow paths that look suspicious but resolve inside workspace', async () => {
      // src/../README.md resolves to README.md which IS inside workspace
      await fs.writeFile(path.join(workspace, 'README.md'), '# test', 'utf8');
      const result = await fileTool.readFile({ path: 'src/../README.md', encoding: 'utf8' });
      expect(result.content).toBe('# test');
    });

    it('should strip leading slashes and confine to workspace', async () => {
      // "/src/index.ts" should be treated as "src/index.ts" relative to workspace
      await fs.ensureDir(path.join(workspace, 'src'));
      await fs.writeFile(path.join(workspace, 'src/index.ts'), 'export {};', 'utf8');
      const result = await fileTool.readFile({ path: '/src/index.ts', encoding: 'utf8' });
      expect(result.content).toBe('export {};');
    });

    it('should block known system paths even if somehow resolved inside', async () => {
      // Simulate a workspace that IS /etc (edge case) — should still block
      const etcTool = new FileTool('/etc');
      await expect(
        etcTool.readFile({ path: 'passwd', encoding: 'utf8' })
      ).rejects.toThrow('Access denied');
    });
  });

  // ── Normal Operations ────────────────────────────────────────────────────

  describe('readFile', () => {
    it('should read an existing file', async () => {
      const testFile = path.join(workspace, 'test.ts');
      await fs.writeFile(testFile, 'const x = 1;', 'utf8');

      const result = await fileTool.readFile({ path: 'test.ts', encoding: 'utf8' });
      expect(result.content).toBe('const x = 1;');
      expect(result.size).toBeGreaterThan(0);
    });

    it('should throw for non-existent file', async () => {
      await expect(
        fileTool.readFile({ path: 'missing.ts', encoding: 'utf8' })
      ).rejects.toThrow('File not found');
    });

    it('should resolve relative paths inside workspace', async () => {
      const subDir = path.join(workspace, 'src');
      await fs.ensureDir(subDir);
      await fs.writeFile(path.join(subDir, 'index.ts'), 'export {};', 'utf8');

      const result = await fileTool.readFile({ path: 'src/index.ts', encoding: 'utf8' });
      expect(result.content).toBe('export {};');
    });
  });

  describe('writeFile', () => {
    it('should write a new file', async () => {
      await fileTool.writeFile({ path: 'new.ts', content: 'const y = 2;', createDirs: true });
      const content = await fs.readFile(path.join(workspace, 'new.ts'), 'utf8');
      expect(content).toBe('const y = 2;');
    });

    it('should create nested directories', async () => {
      await fileTool.writeFile({
        path: 'deep/nested/file.ts',
        content: 'export const deep = true;',
        createDirs: true,
      });
      expect(await fs.pathExists(path.join(workspace, 'deep/nested/file.ts'))).toBe(true);
    });

    it('should overwrite existing file', async () => {
      await fileTool.writeFile({ path: 'file.ts', content: 'v1', createDirs: true });
      await fileTool.writeFile({ path: 'file.ts', content: 'v2', createDirs: true });
      const content = await fs.readFile(path.join(workspace, 'file.ts'), 'utf8');
      expect(content).toBe('v2');
    });
  });

  describe('applyPatch', () => {
    it('should apply a valid patch', async () => {
      const original = 'const x = 1;\nconst y = 2;\n';
      await fs.writeFile(path.join(workspace, 'patch-test.ts'), original, 'utf8');

      const patch = `--- patch-test.ts
+++ patch-test.ts
@@ -1,2 +1,2 @@
-const x = 1;
+const x = 42;
 const y = 2;
`;
      const result = await fileTool.applyPatch({ path: 'patch-test.ts', patch });
      expect(result.success).toBe(true);
      const content = await fs.readFile(path.join(workspace, 'patch-test.ts'), 'utf8');
      expect(content).toContain('const x = 42;');
    });

    it('should throw for invalid patch', async () => {
      await fs.writeFile(path.join(workspace, 'file.ts'), 'original content\n', 'utf8');
      await expect(
        fileTool.applyPatch({ path: 'file.ts', patch: 'invalid patch content' })
      ).rejects.toThrow();
    });
  });

  describe('deleteFile', () => {
    it('should delete a file inside workspace', async () => {
      await fs.writeFile(path.join(workspace, 'to-delete.ts'), 'content', 'utf8');
      await fileTool.deleteFile({ path: 'to-delete.ts' });
      expect(await fs.pathExists(path.join(workspace, 'to-delete.ts'))).toBe(false);
    });

    it('should not throw if file does not exist', async () => {
      await expect(fileTool.deleteFile({ path: 'non-existent.ts' })).resolves.toBeDefined();
    });
  });

  describe('listFiles', () => {
    beforeEach(async () => {
      await fs.writeFile(path.join(workspace, 'a.ts'), '', 'utf8');
      await fs.writeFile(path.join(workspace, 'b.ts'), '', 'utf8');
      await fs.ensureDir(path.join(workspace, 'src'));
      await fs.writeFile(path.join(workspace, 'src', 'c.ts'), '', 'utf8');
    });

    it('should list all matching files', async () => {
      const files = await fileTool.listFiles({
        directory: '.',
        pattern: '**/*.ts',
        ignore: [],
        maxDepth: 5,
      });
      expect(files.length).toBeGreaterThanOrEqual(3);
    });

    it('should respect file pattern', async () => {
      await fs.writeFile(path.join(workspace, 'readme.md'), '', 'utf8');
      const tsFiles = await fileTool.listFiles({
        directory: '.',
        pattern: '**/*.ts',
        ignore: [],
        maxDepth: 5,
      });
      expect(tsFiles.every((f) => f.endsWith('.ts'))).toBe(true);
    });
  });

  describe('searchInFiles', () => {
    beforeEach(async () => {
      await fs.writeFile(path.join(workspace, 'a.ts'), 'const FOO = "bar";\nconst BAZ = "qux";', 'utf8');
      await fs.writeFile(path.join(workspace, 'b.ts'), 'function foo() { return FOO; }', 'utf8');
    });

    it('should find matching lines', async () => {
      const results = await fileTool.searchInFiles({
        directory: '.',
        pattern: 'FOO',
        fileGlob: '**/*.ts',
      });
      expect(results.length).toBeGreaterThan(0);
    });

    it('should return empty for no matches', async () => {
      const results = await fileTool.searchInFiles({
        directory: '.',
        pattern: 'NEVER_FOUND_XYZ',
        fileGlob: '**/*.ts',
      });
      expect(results).toHaveLength(0);
    });
  });
});

describe('FileTool - Unit Tests', () => {
  let workspace: string;
  let fileTool: FileTool;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-file-test-'));
    fileTool = new FileTool(workspace);
  });

  afterEach(async () => {
    await fs.remove(workspace);
  });

  describe('readFile', () => {
    it('should read an existing file', async () => {
      const testFile = path.join(workspace, 'test.ts');
      await fs.writeFile(testFile, 'const x = 1;', 'utf8');

      const result = await fileTool.readFile({ path: 'test.ts', encoding: 'utf8' });
      expect(result.content).toBe('const x = 1;');
      expect(result.size).toBeGreaterThan(0);
    });

    it('should throw for non-existent file', async () => {
      await expect(
        fileTool.readFile({ path: 'missing.ts', encoding: 'utf8' })
      ).rejects.toThrow('File not found');
    });

    it('should resolve relative paths', async () => {
      const subDir = path.join(workspace, 'src');
      await fs.ensureDir(subDir);
      await fs.writeFile(path.join(subDir, 'index.ts'), 'export {};', 'utf8');

      const result = await fileTool.readFile({ path: 'src/index.ts', encoding: 'utf8' });
      expect(result.content).toBe('export {};');
    });
  });

  describe('writeFile', () => {
    it('should write a new file', async () => {
      await fileTool.writeFile({ path: 'new.ts', content: 'const y = 2;', createDirs: true });
      const content = await fs.readFile(path.join(workspace, 'new.ts'), 'utf8');
      expect(content).toBe('const y = 2;');
    });

    it('should create directories when createDirs is true', async () => {
      await fileTool.writeFile({
        path: 'deep/nested/file.ts',
        content: 'export const deep = true;',
        createDirs: true,
      });
      expect(await fs.pathExists(path.join(workspace, 'deep/nested/file.ts'))).toBe(true);
    });

    it('should overwrite existing file', async () => {
      await fileTool.writeFile({ path: 'file.ts', content: 'v1', createDirs: true });
      await fileTool.writeFile({ path: 'file.ts', content: 'v2', createDirs: true });
      const content = await fs.readFile(path.join(workspace, 'file.ts'), 'utf8');
      expect(content).toBe('v2');
    });
  });

  describe('applyPatch', () => {
    it('should apply a valid patch', async () => {
      const original = 'const x = 1;\nconst y = 2;\n';
      await fs.writeFile(path.join(workspace, 'patch-test.ts'), original, 'utf8');

      // Create a patch that changes x=1 to x=42
      const patch = `--- patch-test.ts
+++ patch-test.ts
@@ -1,2 +1,2 @@
-const x = 1;
+const x = 42;
 const y = 2;
`;
      const result = await fileTool.applyPatch({ path: 'patch-test.ts', patch });
      expect(result.success).toBe(true);
      const content = await fs.readFile(path.join(workspace, 'patch-test.ts'), 'utf8');
      expect(content).toContain('const x = 42;');
    });

    it('should throw for invalid patch', async () => {
      await fs.writeFile(path.join(workspace, 'file.ts'), 'original content\n', 'utf8');
      await expect(
        fileTool.applyPatch({ path: 'file.ts', patch: 'invalid patch content' })
      ).rejects.toThrow();
    });
  });

  describe('deleteFile', () => {
    it('should delete a file', async () => {
      await fs.writeFile(path.join(workspace, 'to-delete.ts'), 'content', 'utf8');
      await fileTool.deleteFile({ path: 'to-delete.ts' });
      expect(await fs.pathExists(path.join(workspace, 'to-delete.ts'))).toBe(false);
    });

    it('should not throw if file does not exist', async () => {
      await expect(fileTool.deleteFile({ path: 'non-existent.ts' })).resolves.toBeDefined();
    });
  });

  describe('listFiles', () => {
    beforeEach(async () => {
      await fs.writeFile(path.join(workspace, 'a.ts'), '', 'utf8');
      await fs.writeFile(path.join(workspace, 'b.ts'), '', 'utf8');
      await fs.ensureDir(path.join(workspace, 'src'));
      await fs.writeFile(path.join(workspace, 'src', 'c.ts'), '', 'utf8');
    });

    it('should list all files', async () => {
      const files = await fileTool.listFiles({
        directory: '.',
        pattern: '**/*.ts',
        ignore: [],
        maxDepth: 5,
      });
      expect(files.length).toBeGreaterThanOrEqual(3);
    });

    it('should respect pattern', async () => {
      await fs.writeFile(path.join(workspace, 'readme.md'), '', 'utf8');
      const tsFiles = await fileTool.listFiles({
        directory: '.',
        pattern: '**/*.ts',
        ignore: [],
        maxDepth: 5,
      });
      expect(tsFiles.every((f) => f.endsWith('.ts'))).toBe(true);
    });
  });

  describe('searchInFiles', () => {
    beforeEach(async () => {
      await fs.writeFile(path.join(workspace, 'a.ts'), 'const FOO = "bar";\nconst BAZ = "qux";', 'utf8');
      await fs.writeFile(path.join(workspace, 'b.ts'), 'function foo() { return FOO; }', 'utf8');
    });

    it('should find matching lines', async () => {
      const results = await fileTool.searchInFiles({
        directory: '.',
        pattern: 'FOO',
        fileGlob: '**/*.ts',
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.content.toUpperCase().includes('FOO'))).toBe(true);
    });

    it('should return empty for no matches', async () => {
      const results = await fileTool.searchInFiles({
        directory: '.',
        pattern: 'NEVER_FOUND_XYZ',
        fileGlob: '**/*.ts',
      });
      expect(results).toHaveLength(0);
    });
  });
});
