import simpleGit, { SimpleGit, StatusResult } from 'simple-git';
import * as path from 'path';
import { logger } from '../logger';
import type {
  GitCheckpointInput, GitDiffInput, GitStatusInput, GitPushInput, GitPullInput,
  GitBranchInput, GitLogInput, GitCloneInput, GitMergeInput, GitStashInput,
  GitResetInput, GitRemoteInput,
} from './schemas';

export interface GitCheckpointResult {
  hash: string;
  message: string;
  filesChanged: number;
  branch: string;
}

export interface GitPushResult {
  success: boolean;
  remote: string;
  branch: string;
  commits?: number;
  message: string;
}

export interface GitPullResult {
  success: boolean;
  remote: string;
  branch: string;
  changes: {
    files: number;
    insertions: number;
    deletions: number;
  };
  message: string;
}

export interface GitBranchResult {
  success: boolean;
  action: string;
  branches?: string[];
  current?: string;
  name?: string;
  message: string;
}

export interface GitLogResult {
  commits: Array<{
    hash: string;
    shortHash: string;
    message: string;
    author: string;
    date: string;
  }>;
  total: number;
  branch: string;
}

export interface GitCloneResult {
  success: boolean;
  directory: string;
  branch: string;
  message: string;
}

export interface GitMergeResult {
  success: boolean;
  branch: string;
  conflicts: string[];
  message: string;
}

export interface GitStashResult {
  success: boolean;
  action: string;
  stashes?: Array<{ index: number; message: string }>;
  message: string;
}

export interface GitResetResult {
  success: boolean;
  target: string;
  mode: string;
  message: string;
}

export interface GitRemoteResult {
  success: boolean;
  action: string;
  remotes?: Array<{ name: string; url?: string }>;
  message: string;
}

export class GitTool {
  private git: SimpleGit;

  constructor(private readonly workspaceDir: string) {
    this.git = simpleGit(workspaceDir);
  }

  async ensureRepo(): Promise<void> {
    try {
      await this.git.status();
    } catch {
      logger.info('Initializing git repository', { dir: this.workspaceDir });
      await this.git.init();
      await this.git.addConfig('user.email', 'klaus-code@localhost');
      await this.git.addConfig('user.name', 'AI Agent');
    }
  }

  async checkpoint(input: GitCheckpointInput): Promise<GitCheckpointResult> {
    const repoDir = input.directory
      ? path.resolve(this.workspaceDir, input.directory)
      : this.workspaceDir;

    const git = simpleGit(repoDir);

    try {
      await git.status();
    } catch {
      await git.init();
      await git.addConfig('user.email', 'klaus-code@localhost');
      await git.addConfig('user.name', 'AI Agent');
    }

    logger.info('Creating git checkpoint', { message: input.message, directory: repoDir });

    const status = await git.status();
    if (
      status.modified.length === 0 &&
      status.created.length === 0 &&
      status.deleted.length === 0 &&
      status.not_added.length === 0
    ) {
      logger.info('No changes to checkpoint');
      const log = await git.log(['--oneline', '-1']);
      const branch = await git.revparse(['--abbrev-ref', 'HEAD']);
      return {
        hash: log.latest?.hash ?? 'no-commits',
        message: input.message,
        filesChanged: 0,
        branch: branch.trim(),
      };
    }

    await git.add('.');
    const result = await git.commit(`[AI Agent] ${input.message}`);
    const branch = await git.revparse(['--abbrev-ref', 'HEAD']);
    const filesChanged = status.modified.length + status.created.length + status.deleted.length;

    logger.info('Git checkpoint created', {
      hash: result.commit,
      filesChanged,
      branch: branch.trim(),
    });

    return {
      hash: result.commit,
      message: input.message,
      filesChanged,
      branch: branch.trim(),
    };
  }

  async status(input: GitStatusInput): Promise<StatusResult> {
    const repoDir = input.directory
      ? path.resolve(this.workspaceDir, input.directory)
      : this.workspaceDir;

    const git = simpleGit(repoDir);
    const status = await git.status();
    logger.debug('Git status retrieved', {
      modified: status.modified.length,
      created: status.created.length,
      deleted: status.deleted.length,
    });
    return status;
  }

  async diff(input: GitDiffInput): Promise<string>;
  async diff(args: string[]): Promise<string>;
  async diff(inputOrArgs: GitDiffInput | string[]): Promise<string> {
    // Overload: accept raw git diff args (e.g., ['--cached']) for internal use
    if (Array.isArray(inputOrArgs)) {
      const diff = await this.git.diff(inputOrArgs);
      logger.debug('Git diff retrieved (raw args)', { args: inputOrArgs, length: diff.length });
      return diff;
    }

    const input = inputOrArgs;
    const repoDir = input.directory
      ? path.resolve(this.workspaceDir, input.directory)
      : this.workspaceDir;

    const git = simpleGit(repoDir);
    const diff = input.staged ? await git.diff(['--cached']) : await git.diff();
    logger.debug('Git diff retrieved', { staged: input.staged, length: diff.length });
    return diff;
  }

  async getLastCommitHash(): Promise<string> {
    try {
      const log = await this.git.log(['--oneline', '-1']);
      return log.latest?.hash ?? '';
    } catch {
      return '';
    }
  }

  async push(input: GitPushInput): Promise<GitPushResult> {
    const repoDir = input.directory
      ? path.resolve(this.workspaceDir, input.directory)
      : this.workspaceDir;

    const git = simpleGit(repoDir);

    // Get current branch if not specified
    const branch = input.branch || (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    const remote = input.remote;

    logger.info('Pushing to remote', { remote, branch, force: input.force, directory: repoDir });

    try {
      const args: string[] = [remote, branch];
      
      if (input.force) {
        args.unshift('--force');
      }
      
      if (input.setUpstream) {
        args.unshift('--set-upstream');
      }

      const result = await git.push(args);
      
      logger.info('Git push completed', { remote, branch, pushed: result.pushed });

      return {
        success: true,
        remote,
        branch,
        commits: result.pushed?.length,
        message: `Successfully pushed to ${remote}/${branch}`,
      };
    } catch (err: any) {
      logger.error('Git push failed', { error: err.message, remote, branch });
      
      // Check for common errors and provide helpful messages
      if (err.message.includes('Authentication failed') || err.message.includes('could not read Username')) {
        throw new Error(
          `Git push failed: Authentication required. ` +
          `In Docker mode, set GIT_CREDENTIALS in .env. ` +
          `Format: https://username:token@github.com`
        );
      }
      
      throw err;
    }
  }

  async pull(input: GitPullInput): Promise<GitPullResult> {
    const repoDir = input.directory
      ? path.resolve(this.workspaceDir, input.directory)
      : this.workspaceDir;

    const git = simpleGit(repoDir);

    // Get current branch if not specified
    const branch = input.branch || (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    const remote = input.remote;

    logger.info('Pulling from remote', { remote, branch, rebase: input.rebase, directory: repoDir });

    try {
      const options: string[] = [];
      
      if (input.rebase) {
        options.push('--rebase');
      }

      const result = await git.pull(remote, branch, options);
      
      // Extract numeric values safely (newer simple-git types may return objects)
      const insertions = typeof result.insertions === 'number' ? result.insertions : 0;
      const deletions = typeof result.deletions === 'number' ? result.deletions : 0;
      
      logger.info('Git pull completed', {
        remote,
        branch,
        files: result.files?.length ?? 0,
        insertions,
        deletions,
      });

      return {
        success: true,
        remote,
        branch,
        changes: {
          files: result.files?.length ?? 0,
          insertions,
          deletions,
        },
        message: result.files?.length
          ? `Pulled ${result.files.length} file(s) from ${remote}/${branch}`
          : `Already up to date with ${remote}/${branch}`,
      };
    } catch (err: any) {
      logger.error('Git pull failed', { error: err.message, remote, branch });
      
      // Check for common errors and provide helpful messages
      if (err.message.includes('Authentication failed') || err.message.includes('could not read Username')) {
        throw new Error(
          `Git pull failed: Authentication required. ` +
          `In Docker mode, set GIT_CREDENTIALS in .env. ` +
          `Format: https://username:token@github.com`
        );
      }
      
      throw err;
    }
  }

  // ─── Branch Operations ──────────────────────────────────────────────────────

  async branch(input: GitBranchInput): Promise<GitBranchResult> {
    const repoDir = input.directory
      ? path.resolve(this.workspaceDir, input.directory)
      : this.workspaceDir;

    const git = simpleGit(repoDir);

    logger.info('Git branch operation', { action: input.action, name: input.name, directory: repoDir });

    try {
      switch (input.action) {
        case 'list': {
          const branchSummary = await git.branch(['-a']);
          const branches = branchSummary.all;
          const current = branchSummary.current;
          
          return {
            success: true,
            action: 'list',
            branches,
            current,
            message: `Found ${branches.length} branch(es), current: ${current}`,
          };
        }

        case 'create': {
          if (!input.name) throw new Error('Branch name is required for create action');
          
          const args = [input.name];
          if (input.startPoint) args.push(input.startPoint);
          
          await git.branch(args);
          
          return {
            success: true,
            action: 'create',
            name: input.name,
            message: `Created branch '${input.name}'${input.startPoint ? ` from ${input.startPoint}` : ''}`,
          };
        }

        case 'delete': {
          if (!input.name) throw new Error('Branch name is required for delete action');
          
          const flag = input.force ? '-D' : '-d';
          await git.branch([flag, input.name]);
          
          return {
            success: true,
            action: 'delete',
            name: input.name,
            message: `Deleted branch '${input.name}'`,
          };
        }

        case 'switch': {
          if (!input.name) throw new Error('Branch name is required for switch action');
          
          const args = input.force ? ['-f', input.name] : [input.name];
          await git.checkout(args);
          
          return {
            success: true,
            action: 'switch',
            name: input.name,
            current: input.name,
            message: `Switched to branch '${input.name}'`,
          };
        }

        default:
          throw new Error(`Unknown branch action: ${input.action}`);
      }
    } catch (err: any) {
      logger.error('Git branch operation failed', { error: err.message, action: input.action });
      throw err;
    }
  }

  // ─── Log ────────────────────────────────────────────────────────────────────

  async log(input: GitLogInput): Promise<GitLogResult> {
    const repoDir = input.directory
      ? path.resolve(this.workspaceDir, input.directory)
      : this.workspaceDir;

    const git = simpleGit(repoDir);

    logger.info('Git log', { maxCount: input.maxCount, branch: input.branch, directory: repoDir });

    try {
      const args: string[] = [`--max-count=${input.maxCount}`];
      
      if (input.author) {
        args.push(`--author=${input.author}`);
      }
      
      if (input.branch) {
        args.push(input.branch);
      }

      const logResult = await git.log(args);
      const currentBranch = input.branch || (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();

      const commits = (logResult.all ?? []).map((entry: any) => ({
        hash: entry.hash,
        shortHash: entry.hash.slice(0, 8),
        message: entry.message,
        author: entry.author_name,
        date: entry.date,
      }));

      return {
        commits,
        total: commits.length,
        branch: currentBranch,
      };
    } catch (err: any) {
      logger.error('Git log failed', { error: err.message });
      throw err;
    }
  }

  // ─── Clone ──────────────────────────────────────────────────────────────────

  async clone(input: GitCloneInput): Promise<GitCloneResult> {
    const targetDir = input.directory
      ? path.resolve(this.workspaceDir, input.directory)
      : this.workspaceDir;

    logger.info('Git clone', { url: input.url, directory: targetDir, branch: input.branch });

    try {
      const args: string[] = [];
      
      if (input.branch) {
        args.push('--branch', input.branch);
      }
      
      if (input.depth) {
        args.push('--depth', String(input.depth));
      }

      // Clone into workspace
      const git = simpleGit(this.workspaceDir);
      await git.clone(input.url, targetDir, args);

      // Get the actual branch after clone
      const clonedGit = simpleGit(targetDir);
      const branch = (await clonedGit.revparse(['--abbrev-ref', 'HEAD'])).trim();

      return {
        success: true,
        directory: targetDir,
        branch,
        message: `Cloned ${input.url} into ${targetDir}`,
      };
    } catch (err: any) {
      logger.error('Git clone failed', { error: err.message, url: input.url });
      
      if (err.message.includes('Authentication failed') || err.message.includes('could not read Username')) {
        throw new Error(
          `Git clone failed: Authentication required. ` +
          `In Docker mode, set GIT_CREDENTIALS in .env. ` +
          `Format: https://username:token@github.com`
        );
      }
      
      throw err;
    }
  }

  // ─── Merge ──────────────────────────────────────────────────────────────────

  async merge(input: GitMergeInput): Promise<GitMergeResult> {
    const repoDir = input.directory
      ? path.resolve(this.workspaceDir, input.directory)
      : this.workspaceDir;

    const git = simpleGit(repoDir);

    logger.info('Git merge', { branch: input.branch, noFastForward: input.noFastForward, squash: input.squash });

    try {
      const args: string[] = [input.branch];
      
      if (input.noFastForward) {
        args.unshift('--no-ff');
      }
      
      if (input.squash) {
        args.unshift('--squash');
      }
      
      if (input.message) {
        args.unshift('-m', input.message);
      }

      const result = await git.merge(args);

      // Check for conflicts
      const status = await git.status();
      const conflicts = status.conflicted;

      if (conflicts.length > 0) {
        return {
          success: false,
          branch: input.branch,
          conflicts,
          message: `Merge has conflicts in ${conflicts.length} file(s): ${conflicts.join(', ')}`,
        };
      }

      return {
        success: true,
        branch: input.branch,
        conflicts: [],
        message: result.result ?? `Merged branch '${input.branch}'`,
      };
    } catch (err: any) {
      logger.error('Git merge failed', { error: err.message, branch: input.branch });
      throw err;
    }
  }

  // ─── Stash ──────────────────────────────────────────────────────────────────

  async stash(input: GitStashInput): Promise<GitStashResult> {
    const repoDir = input.directory
      ? path.resolve(this.workspaceDir, input.directory)
      : this.workspaceDir;

    const git = simpleGit(repoDir);

    logger.info('Git stash', { action: input.action, directory: repoDir });

    try {
      switch (input.action) {
        case 'push': {
          const args: string[] = ['push'];
          if (input.message) args.push('-m', input.message);
          if (input.includeUntracked) args.push('--include-untracked');
          
          await git.stash(args);
          
          return {
            success: true,
            action: 'push',
            message: input.message ? `Stashed changes: ${input.message}` : 'Stashed changes',
          };
        }

        case 'pop': {
          const index = input.index ?? 0;
          await git.stash(['pop', `stash@{${index}}`]);
          
          return {
            success: true,
            action: 'pop',
            message: `Popped stash@{${index}}`,
          };
        }

        case 'apply': {
          const index = input.index ?? 0;
          await git.stash(['apply', `stash@{${index}}`]);
          
          return {
            success: true,
            action: 'apply',
            message: `Applied stash@{${index}}`,
          };
        }

        case 'drop': {
          const index = input.index ?? 0;
          await git.stash(['drop', `stash@{${index}}`]);
          
          return {
            success: true,
            action: 'drop',
            message: `Dropped stash@{${index}}`,
          };
        }

        case 'list': {
          const result = await git.stash(['list']);
          const stashes = result
            .split('\n')
            .filter(Boolean)
            .map((line, index) => {
              const match = line.match(/stash@\{(\d+)\}:\s*(.+)/);
              return {
                index: match ? parseInt(match[1], 10) : index,
                message: match ? match[2] : line,
              };
            });

          return {
            success: true,
            action: 'list',
            stashes,
            message: stashes.length > 0 ? `Found ${stashes.length} stash(es)` : 'No stashes',
          };
        }

        case 'clear': {
          await git.stash(['clear']);
          
          return {
            success: true,
            action: 'clear',
            message: 'Cleared all stashes',
          };
        }

        default:
          throw new Error(`Unknown stash action: ${input.action}`);
      }
    } catch (err: any) {
      logger.error('Git stash failed', { error: err.message, action: input.action });
      throw err;
    }
  }

  // ─── Reset ──────────────────────────────────────────────────────────────────

  async reset(input: GitResetInput): Promise<GitResetResult> {
    const repoDir = input.directory
      ? path.resolve(this.workspaceDir, input.directory)
      : this.workspaceDir;

    const git = simpleGit(repoDir);

    logger.info('Git reset', { target: input.target, mode: input.mode, directory: repoDir });

    try {
      const args: string[] = [`--${input.mode}`, input.target];
      await git.reset(args);

      return {
        success: true,
        target: input.target,
        mode: input.mode,
        message: `Reset ${input.mode} to ${input.target}`,
      };
    } catch (err: any) {
      logger.error('Git reset failed', { error: err.message, target: input.target });
      throw err;
    }
  }

  // ─── Remote ─────────────────────────────────────────────────────────────────

  async remote(input: GitRemoteInput): Promise<GitRemoteResult> {
    const repoDir = input.directory
      ? path.resolve(this.workspaceDir, input.directory)
      : this.workspaceDir;

    const git = simpleGit(repoDir);

    logger.info('Git remote', { action: input.action, name: input.name, directory: repoDir });

    try {
      switch (input.action) {
        case 'list': {
          const remotes = await git.getRemotes(true);
          
          return {
            success: true,
            action: 'list',
            remotes: remotes.map(r => ({
              name: r.name,
              url: r.refs.fetch || r.refs.push,
            })),
            message: `Found ${remotes.length} remote(s)`,
          };
        }

        case 'add': {
          if (!input.name || !input.url) {
            throw new Error('Remote name and URL are required for add action');
          }
          
          await git.addRemote(input.name, input.url);
          
          return {
            success: true,
            action: 'add',
            message: `Added remote '${input.name}' -> ${input.url}`,
          };
        }

        case 'remove': {
          if (!input.name) throw new Error('Remote name is required for remove action');
          
          await git.removeRemote(input.name);
          
          return {
            success: true,
            action: 'remove',
            message: `Removed remote '${input.name}'`,
          };
        }

        case 'get-url': {
          if (!input.name) throw new Error('Remote name is required for get-url action');
          
          const remotes = await git.getRemotes(true);
          const remote = remotes.find(r => r.name === input.name);
          
          if (!remote) {
            throw new Error(`Remote '${input.name}' not found`);
          }
          
          return {
            success: true,
            action: 'get-url',
            remotes: [{ name: input.name, url: remote.refs.fetch || remote.refs.push }],
            message: `${input.name}: ${remote.refs.fetch || remote.refs.push}`,
          };
        }

        case 'set-url': {
          if (!input.name || !input.url) {
            throw new Error('Remote name and URL are required for set-url action');
          }
          
          await git.remote(['set-url', input.name, input.url]);
          
          return {
            success: true,
            action: 'set-url',
            message: `Updated remote '${input.name}' -> ${input.url}`,
          };
        }

        default:
          throw new Error(`Unknown remote action: ${input.action}`);
      }
    } catch (err: any) {
      logger.error('Git remote failed', { error: err.message, action: input.action });
      throw err;
    }
  }

  async rollbackToLastCheckpoint(): Promise<void> {
    logger.warn('Rolling back to last checkpoint');
    await this.git.checkout(['.']);
    logger.info('Rollback complete');
  }

  // ─── Agent commit history ──────────────────────────────────────────────────

  /**
   * Return a structured list of commits made by the agent (author "AI Agent"),
   * most recent first.
   */
  async agentLog(limit = 50): Promise<AgentCommit[]> {
    try {
      const log = await this.git.log([
        `--max-count=${limit}`,
        '--author=AI Agent',
        '--format=%H\x1f%s\x1f%ad\x1f%an',
        '--date=iso',
      ]);

      return (log.all ?? []).map((entry: any) => ({
        hash:      entry.hash,
        message:   entry.message,
        date:      new Date(entry.date),
        author:    entry.author_name ?? 'AI Agent',
        shortHash: entry.hash.slice(0, 8),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Return the full unified diff for a single commit, along with a list of
   * the files it touched and a summary line.
   */
  async agentShow(hash: string): Promise<AgentCommitDetail> {
    const diff        = await this.git.show([hash, '--stat', '--patch']);
    const nameOnly    = await this.git.show([hash, '--name-status', '--format=']);
    const logEntry    = await this.git.log(['-1', '--format=%s\x1f%ad\x1f%an', '--date=iso', hash]);

    const parts   = (logEntry.latest?.message ?? '').split('\x1f');
    const message = parts[0] ?? '';
    const date    = parts[1] ? new Date(parts[1]) : new Date();
    const author  = parts[2] ?? 'AI Agent';

    const files: ChangedFile[] = nameOnly
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [status, ...rest] = line.trim().split(/\s+/);
        return {
          status: status as 'A' | 'M' | 'D' | 'R',
          path:   rest.join(' '),
        };
      });

    return { hash, shortHash: hash.slice(0, 8), message, date, author, files, diff };
  }
}

export interface AgentCommit {
  hash:      string;
  shortHash: string;
  message:   string;
  date:      Date;
  author:    string;
}

export interface ChangedFile {
  status: 'A' | 'M' | 'D' | 'R';
  path:   string;
}

export interface AgentCommitDetail extends AgentCommit {
  files: ChangedFile[];
  diff:  string;
}
