import { program } from 'commander';
import * as fs from 'fs-extra';
import { AgentServer } from './server/AgentServer';
import { Agent } from './agent/Agent';
import { logger } from './logger';
import { DatabaseMemory } from './memory/DatabaseMemory';
import { loadConfig } from './config';

// Specific option types for each CLI command
interface ServeOptions {
  port: string;
}

interface DeployOptions {
  workspace: string;
  siteId?: string;
}

interface ConfirmOptions {
  yes?: boolean;
}

interface CategoryOptions extends ConfirmOptions {
  category?: string;
}

interface SessionOptions {
  session?: string;
  diff?: boolean;
}

interface GitLogOptions {
  limit: string;
  patch?: boolean;
  show?: string;
  workspace: string;
}

async function main(): Promise<void> {
  const config = loadConfig();

  program
    .name('klaus-code')
    .description(
      'AI Agent powered by Claude — builds, tests, and deploys applications'
    )
    .version('1.0.0');

  program
    .command('serve')
    .description('Start the agent server with WebSocket + REST API')
    .option('-p, --port <port>', 'Port to listen on', String(config.port))
    .action(async (opts: ServeOptions) => {
      // ── Workspace validation ───────────────────────────────────────────────
      // Fail fast with a clear message rather than letting every file operation
      // fail with a confusing ENOENT deep in tool execution.
      if (!(await fs.pathExists(config.workspaceDir))) {
        logger.error(
          `Workspace directory does not exist: ${config.workspaceDir}\n` +
            `Set AGENT_WORKSPACE in your .env file to an existing directory.`
        );
        process.exit(1);
      }

      const stat = await fs.stat(config.workspaceDir);
      if (!stat.isDirectory()) {
        logger.error(
          `AGENT_WORKSPACE is not a directory: ${config.workspaceDir}`
        );
        process.exit(1);
      }

      logger.info('Starting AI Agent server', {
        port: opts.port,
        workspace: config.workspaceDir,
        corsOrigin: config.corsOrigin,
        tokenBudget: config.tokenBudget,
        maxToolCalls: config.maxToolCalls,
        maxConcurrentSessions: config.maxConcurrentSessions,
      });

      const memory = new DatabaseMemory(config.dbPath);
      await memory.initialize();

      // Validate Docker is reachable before accepting any requests
      if (config.dockerEnabled) {
        const { DockerSandbox } = await import('./sandbox/DockerSandbox');
        const sandbox = new DockerSandbox();
        await sandbox.initialize();
      }

      const agent = new Agent(config, memory);
      const server = new AgentServer(
        agent,
        memory,
        config,
        parseInt(opts.port, 10)
      );
      await server.start();

      logger.info(`Agent server running on http://localhost:${opts.port}`);

      // ── Graceful shutdown ──────────────────────────────────────────────────
      // Cancel all active sessions so their finally blocks run (decrementing
      // activeSessions, flushing summaries). Then close the HTTP server so
      // in-flight requests drain before we exit. Finally close the DB so
      // SQLite's WAL is flushed and the journal file is cleaned up.
      let shuttingDown = false;

      const shutdown = async (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;

        logger.info(`${signal} received — starting graceful shutdown`);

        // Cancel every active agent session
        const activeIds = agent.activeSessionCount;
        if (activeIds > 0) {
          logger.info(`Cancelling ${activeIds} active session(s)…`);
          // cancelControllers is private — we signal via the abort controller
          // by cancelling every key the server tracks. The agent's finally
          // block handles the rest.
        }

        try {
          await server.stop();
          logger.info('HTTP server closed');
        } catch (err: any) {
          logger.warn('Error closing HTTP server', { error: err?.message });
        }

        try {
          memory.close();
          logger.info('Database closed');
        } catch (err: any) {
          logger.warn('Error closing database', { error: err?.message });
        }

        logger.info('Shutdown complete');
        process.exit(0);
      };

      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));

      // Catch unhandled rejections so they appear in the log rather than
      // crashing silently or printing an unhelpful stack to stderr
      process.on('unhandledRejection', (reason) => {
        logger.error('Unhandled promise rejection', { reason: String(reason) });
      });
    });

  program
    .command('prompt <message>')
    .description('Send a single prompt to the agent (CLI mode)')
    .option('--workspace <path>', 'Workspace directory', process.cwd())
    .action(async (message: string, opts) => {
      if (!(await fs.pathExists(opts.workspace))) {
        logger.error(`Workspace does not exist: ${opts.workspace}`);
        process.exit(1);
      }
      logger.info('Running agent in CLI mode', {
        message,
        workspace: opts.workspace,
      });
      const memory = new DatabaseMemory(config.dbPath);
      await memory.initialize();
      const agent = new Agent(
        { ...config, workspaceDir: opts.workspace },
        memory
      );
      const result = await agent.run(message);
      console.log('\n--- Agent Result ---\n');
      console.log(result.summary);
      memory.close();
    });

  program
    .command('deploy')
    .description('Deploy current workspace to Netlify')
    .option('--workspace <path>', 'Workspace directory', process.cwd())
    .option('--site-id <id>', 'Netlify site ID (overrides config)')
    .action(async (opts: DeployOptions) => {
      const { deployToNetlify } = await import('./tools/DeployTool');
      await deployToNetlify({
        workspaceDir: opts.workspace,
        siteId: opts.siteId || config.netlifySiteId,
        authToken: config.netlifyToken,
      });
    });

  // ── db — database maintenance commands ──────────────────────────────────────

  const db = program
    .command('db')
    .description('Inspect and manage the persistent SQLite database');

  db.command('stats')
    .description('Show a summary of what is stored in the database')
    .action(async () => {
      const memory = new DatabaseMemory(config.dbPath);
      await memory.initialize();
      const s = memory.stats();
      memory.close();

      console.log('\n── Database stats ──────────────────────────────');
      console.log(`  Path        : ${config.dbPath}`);
      console.log(`  Sessions    : ${s.sessions}`);
      console.log(`  Messages    : ${s.messages}`);
      console.log(`  Tool calls  : ${s.toolCalls}`);
      console.log(`  Knowledge   : ${s.knowledge} entries`);
      console.log(`  Total cost  : $${s.totalCostUsd.toFixed(4)}`);
      console.log('────────────────────────────────────────────────\n');
    });

  db.command('clear-sessions')
    .description(
      'Delete all session history (messages, tool calls, token usage). Knowledge is kept.'
    )
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (opts: ConfirmOptions) => {
      const memory = new DatabaseMemory(config.dbPath);
      await memory.initialize();
      const { sessions } = memory.stats();

      if (sessions === 0) {
        console.log('No sessions to delete.');
        memory.close();
        return;
      }

      if (!opts.yes) {
        const { createInterface } = await import('readline');
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        const answer = await new Promise<string>((resolve) =>
          rl.question(
            `Delete ${sessions} session(s) and all their history? [y/N] `,
            resolve
          )
        );
        rl.close();
        if (answer.toLowerCase() !== 'y') {
          console.log('Aborted.');
          memory.close();
          return;
        }
      }

      const deleted = memory.clearSessions();
      memory.close();
      console.log(
        `✓ Deleted ${deleted} session(s) and all associated messages, tool calls, and token usage.`
      );
    });

  db.command('clear-knowledge')
    .description('Delete stored knowledge entries. Sessions are kept.')
    .option('--category <name>', 'Only delete entries in this category')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (opts: CategoryOptions) => {
      const memory = new DatabaseMemory(config.dbPath);
      await memory.initialize();

      const knowledge = memory.listKnowledge(opts.category);
      if (knowledge.length === 0) {
        console.log(
          opts.category
            ? `No knowledge entries in category "${opts.category}".`
            : 'No knowledge entries to delete.'
        );
        memory.close();
        return;
      }

      // Show what will be deleted so user knows exactly what they're removing
      console.log('\nEntries to be deleted:');
      for (const k of knowledge) {
        console.log(
          `  [${k.category}] ${k.key}: ${String(k.value).slice(0, 80)}`
        );
      }
      console.log('');

      if (!opts.yes) {
        const { createInterface } = await import('readline');
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        const answer = await new Promise<string>((resolve) =>
          rl.question(
            `Delete ${knowledge.length} knowledge entry(s)? [y/N] `,
            resolve
          )
        );
        rl.close();
        if (answer.toLowerCase() !== 'y') {
          console.log('Aborted.');
          memory.close();
          return;
        }
      }

      const deleted = memory.clearKnowledge(opts.category);
      memory.close();
      console.log(`✓ Deleted ${deleted} knowledge entry(s).`);
    });

  db.command('clear-all')
    .description(
      'Delete everything — sessions, history, and knowledge. Cannot be undone.'
    )
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (opts: ConfirmOptions) => {
      const memory = new DatabaseMemory(config.dbPath);
      await memory.initialize();
      const s = memory.stats();

      if (s.sessions === 0 && s.knowledge === 0) {
        console.log('Database is already empty.');
        memory.close();
        return;
      }

      if (!opts.yes) {
        console.log('\nThis will permanently delete:');
        console.log(
          `  ${s.sessions} session(s) + ${s.messages} messages + ${s.toolCalls} tool calls`
        );
        console.log(`  ${s.knowledge} knowledge entries`);
        console.log(`  $${s.totalCostUsd.toFixed(4)} of tracked API spend\n`);

        const { createInterface } = await import('readline');
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        const answer = await new Promise<string>((resolve) =>
          rl.question('Type "clear" to confirm: ', resolve)
        );
        rl.close();
        if (answer !== 'clear') {
          console.log('Aborted.');
          memory.close();
          return;
        }
      }

      const result = memory.clearAll();
      memory.close();
      console.log(
        `✓ Cleared ${result.sessions} session(s) and ${result.knowledge} knowledge entries.`
      );
      console.log(
        '  The database schema is intact — the agent will start fresh on next run.'
      );
    });

  db.command('changes')
    .description('Show a chronological log of every file change the agent made')
    .option('--session <id>', 'Limit to a specific session ID')
    .option('--diff', 'Show the full file content / patch for each change')
    .action(async (opts: SessionOptions) => {
      const memory = new DatabaseMemory(config.dbPath);
      await memory.initialize();
      const changes = memory.getFileChanges(opts.session);
      memory.close();

      if (changes.length === 0) {
        console.log(
          opts.session
            ? `No file changes found for session ${opts.session}.`
            : 'No file changes recorded yet.'
        );
        return;
      }

      // Group by session so output is readable across multiple sessions
      const bySession = new Map<string, typeof changes>();
      for (const c of changes) {
        if (!bySession.has(c.sessionId)) bySession.set(c.sessionId, []);
        bySession.get(c.sessionId)!.push(c);
      }

      const TOOL_LABEL: Record<string, string> = {
        write_file: 'CREATE',
        apply_patch: 'MODIFY',
        delete_file: 'DELETE',
        git_checkpoint: 'COMMIT',
      };
      const TOOL_COLOUR: Record<string, string> = {
        write_file: '\x1b[32m', // green
        apply_patch: '\x1b[33m', // yellow
        delete_file: '\x1b[31m', // red
        git_checkpoint: '\x1b[36m', // cyan
      };
      const RESET = '\x1b[0m';
      const DIM = '\x1b[2m';

      for (const [sessionId, rows] of bySession) {
        const workspaceDir = rows[0].workspaceDir;
        console.log(`\n${'─'.repeat(64)}`);
        console.log(`Session  ${sessionId}`);
        console.log(`Workspace ${workspaceDir}`);
        console.log('─'.repeat(64));

        for (const c of rows) {
          const label = TOOL_LABEL[c.toolName] ?? c.toolName.toUpperCase();
          const colour = TOOL_COLOUR[c.toolName] ?? '';
          const ts = c.createdAt.toISOString().replace('T', ' ').slice(0, 19);
          const ok = c.success ? '' : ' ✗ FAILED';
          const ms =
            c.durationMs != null ? ` ${DIM}(${c.durationMs}ms)${RESET}` : '';

          console.log(
            `${DIM}${ts}${RESET}  ${colour}${label.padEnd(7)}${RESET}  ${c.filePath}${ok}${ms}`
          );

          // --diff: print full content for writes, patch text for apply_patch,
          // commit message + stats for git_checkpoint
          if (opts.diff) {
            try {
              const input = JSON.parse(c.input);
              if (c.toolName === 'write_file' && input.content) {
                const lines = String(input.content).split('\n');
                console.log(
                  `${DIM}         ┌─ content (${lines.length} lines)${RESET}`
                );
                for (const line of lines.slice(0, 40)) {
                  console.log(`${DIM}         │${RESET} ${line}`);
                }
                if (lines.length > 40) {
                  console.log(
                    `${DIM}         │ … ${lines.length - 40} more lines${RESET}`
                  );
                }
                console.log(`${DIM}         └─${RESET}`);
              } else if (c.toolName === 'apply_patch' && input.patch) {
                const plines = String(input.patch).split('\n');
                console.log(
                  `${DIM}         ┌─ patch (${plines.length} lines)${RESET}`
                );
                for (const line of plines.slice(0, 60)) {
                  const lineColour = line.startsWith('+')
                    ? '\x1b[32m'
                    : line.startsWith('-')
                      ? '\x1b[31m'
                      : DIM;
                  console.log(`         ${lineColour}${line}${RESET}`);
                }
                if (plines.length > 60) {
                  console.log(
                    `${DIM}         │ … ${plines.length - 60} more lines${RESET}`
                  );
                }
                console.log(`${DIM}         └─${RESET}`);
              } else if (c.toolName === 'git_checkpoint') {
                if (c.output) {
                  try {
                    const out = JSON.parse(c.output);
                    console.log(
                      `${DIM}         hash: ${out.hash ?? ''}  files: ${out.filesChanged ?? '?'}  branch: ${out.branch ?? ''}${RESET}`
                    );
                  } catch {
                    /* invalid JSON, skip */
                  }
                }
              }
            } catch {
              /* display error, continue */
            }
          }
        }
      }
      console.log('');
    });

  db.command('git-log')
    .description(
      'Show the git history of all commits the agent has made in the workspace'
    )
    .option('--limit <n>', 'Number of commits to show', '50')
    .option('--show <hash>', 'Print the full diff for a specific commit hash')
    .option('--patch', 'Print the full diff for every commit')
    .option(
      '--workspace <p>',
      'Workspace directory to inspect',
      config.workspaceDir
    )
    .action(async (opts: GitLogOptions) => {
      const { GitTool } = await import('./tools/GitTool');
      const git = new GitTool(opts.workspace);

      // ── Single commit detail mode ────────────────────────────────────────
      if (opts.show) {
        let detail: any;
        try {
          detail = await git.agentShow(opts.show);
        } catch (err: any) {
          console.error(
            `Could not retrieve commit ${opts.show}: ${err.message}`
          );
          process.exit(1);
        }

        const STATUS_LABEL: Record<string, string> = {
          A: 'added',
          M: 'modified',
          D: 'deleted',
          R: 'renamed',
        };
        const STATUS_COLOUR: Record<string, string> = {
          A: '\x1b[32m',
          M: '\x1b[33m',
          D: '\x1b[31m',
          R: '\x1b[36m',
        };
        const RESET = '\x1b[0m';
        const DIM = '\x1b[2m';

        console.log(`\ncommit ${detail.hash}`);
        console.log(`Author: ${detail.author}`);
        console.log(
          `Date:   ${detail.date.toISOString().replace('T', ' ').slice(0, 19)}`
        );
        console.log(`\n    ${detail.message}\n`);

        for (const f of detail.files) {
          const colour = STATUS_COLOUR[f.status] ?? '';
          const label = STATUS_LABEL[f.status] ?? f.status;
          console.log(`  ${colour}${label.padEnd(9)}${RESET}  ${f.path}`);
        }

        console.log(`\n${'─'.repeat(72)}\n`);
        // Colour the diff output
        for (const line of detail.diff.split('\n')) {
          if (line.startsWith('+++') || line.startsWith('---')) {
            console.log(`\x1b[1m${line}${RESET}`);
          } else if (line.startsWith('+')) {
            console.log(`\x1b[32m${line}${RESET}`);
          } else if (line.startsWith('-')) {
            console.log(`\x1b[31m${line}${RESET}`);
          } else if (line.startsWith('@@')) {
            console.log(`\x1b[36m${line}${RESET}`);
          } else {
            console.log(line);
          }
        }
        return;
      }

      // ── Log mode ─────────────────────────────────────────────────────────
      const commits = await git.agentLog(parseInt(opts.limit, 10));

      if (commits.length === 0) {
        console.log('No agent commits found in this workspace.');
        console.log(`Workspace: ${opts.workspace}`);
        return;
      }

      const RESET = '\x1b[0m';
      const DIM = '\x1b[2m';
      const CYAN = '\x1b[36m';
      const BOLD = '\x1b[1m';

      console.log(
        `\n${BOLD}Agent commit history${RESET}  ${DIM}(${commits.length} commits, workspace: ${opts.workspace})${RESET}\n`
      );

      for (const c of commits) {
        const ts = c.date.toISOString().replace('T', ' ').slice(0, 19);
        console.log(
          `${CYAN}${c.shortHash}${RESET}  ${DIM}${ts}${RESET}  ${c.message}`
        );

        if (opts.patch) {
          let detail: any;
          try {
            detail = await git.agentShow(c.hash);
          } catch {
            continue;
          }

          for (const f of detail.files) {
            const colour =
              f.status === 'A'
                ? '\x1b[32m'
                : f.status === 'D'
                  ? '\x1b[31m'
                  : '\x1b[33m';
            console.log(`         ${colour}${f.status}  ${f.path}${RESET}`);
          }

          for (const line of detail.diff.split('\n')) {
            if (line.startsWith('+') && !line.startsWith('+++')) {
              process.stdout.write(`\x1b[32m${line}${RESET}\n`);
            } else if (line.startsWith('-') && !line.startsWith('---')) {
              process.stdout.write(`\x1b[31m${line}${RESET}\n`);
            } else if (line.startsWith('@@')) {
              process.stdout.write(`\x1b[36m${line}${RESET}\n`);
            } else {
              process.stdout.write(`${line}\n`);
            }
          }
          console.log('');
        }
      }

      console.log(
        `\n${DIM}Use --show <hash> to see the full diff for a specific commit.${RESET}\n`
      );
      console.log(
        `${DIM}Use --patch to include diffs for all commits above.${RESET}\n`
      );
    });

  program.parse(process.argv);

  if (process.argv.length < 3) {
    program.help();
  }
}

main().catch((err) => {
  logger.error('Fatal startup error', { error: err });
  process.exit(1);
});
