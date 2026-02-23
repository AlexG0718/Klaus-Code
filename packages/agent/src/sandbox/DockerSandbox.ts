import Docker from 'dockerode';
import { Writable } from 'stream';
import { logger } from '../logger';

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxOptions {
  timeout?: number;   // ms, default 60000
  memoryMb?: number;  // default 512
  cpus?: number;      // default 1.0
  env?: Record<string, string>;
}

// The image used for all sandboxed execution.
// node:20-alpine is small, has npm/npx/node/git pre-installed, and has no
// unnecessary system tools. Pin to a digest in production for full reproducibility.
const SANDBOX_IMAGE = 'node:20-alpine';

// UID/GID of the non-root user we run as inside the container.
// node:20-alpine ships with a built-in "node" user at uid 1000.
const SANDBOX_USER = 'node';

export class DockerSandbox {
  private docker: Docker;
  private imageReady = false;
  // Host path for bind mounts - in DooD mode, we need the HOST path, not container path
  private hostWorkspaceDir: string | undefined;

  constructor() {
    this.docker = new Docker();
    // Read host workspace path from environment for DooD bind mounts
    this.hostWorkspaceDir = process.env.AGENT_HOST_WORKSPACE;
  }

  /**
   * Verify Docker is reachable and the sandbox image is available.
   * Call this once at startup — it fails fast rather than failing on first use.
   */
  async initialize(): Promise<void> {
    logger.info('Initializing Docker sandbox', { image: SANDBOX_IMAGE });

    // Check Docker daemon is accessible
    try {
      await this.docker.ping();
    } catch (err: any) {
      throw new Error(
        `Docker daemon is not reachable: ${err.message}\n` +
        `Ensure Docker Desktop (or Docker Engine) is running, or set DOCKER_ENABLED=false.`
      );
    }

    // Pull image if not already present
    const images = await this.docker.listImages({ filters: { reference: [SANDBOX_IMAGE] } });
    if (images.length === 0) {
      logger.info('Sandbox image not found locally — pulling', { image: SANDBOX_IMAGE });
      await this.pullImage();
    } else {
      logger.info('Sandbox image already present', { image: SANDBOX_IMAGE });
    }

    this.imageReady = true;
    logger.info('Docker sandbox ready');
  }

  async execute(
    command: string,
    workspaceDir: string,
    options: SandboxOptions = {}
  ): Promise<SandboxResult> {
    if (!this.imageReady) {
      await this.initialize();
    }

    const { timeout = 60000, memoryMb = 512, cpus = 1.0, env = {} } = options;

    logger.info('Executing in Docker sandbox', {
      command: command.slice(0, 200),
      workspaceDir,
      hostWorkspaceDir: this.hostWorkspaceDir || workspaceDir,
      memoryMb,
      cpus,
      timeout,
    });

    const start = Date.now();
    let container: Docker.Container | null = null;

    try {
      container = await this.docker.createContainer({
        Image: SANDBOX_IMAGE,
        User: SANDBOX_USER,           // Non-root — uid 1000 inside container
        WorkingDir: '/workspace',
        Cmd: ['sh', '-c', command],
        Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),

        HostConfig: {
          // ── Filesystem ──────────────────────────────────────────────────
          // Workspace mounted read-write so the agent can create files.
          // Nothing else from the host is mounted — no home dir, no secrets.
          // In DooD mode, we use the HOST path (hostWorkspaceDir) for bind mounts
          // since the Docker daemon runs on the host, not in the agent container.
          Binds: [`${this.hostWorkspaceDir || workspaceDir}:/workspace:rw`],
          Tmpfs: { '/tmp': 'size=64m,noexec' }, // Writable /tmp, no exec bit

          // ── Network ─────────────────────────────────────────────────────
          // Completely disabled. npm install etc. won't work inside the
          // sandbox — those should be run by the agent BEFORE entering the
          // sandbox, or the workspace should have node_modules pre-installed.
          NetworkMode: 'none',

          // ── Resources ───────────────────────────────────────────────────
          Memory: memoryMb * 1024 * 1024,
          MemorySwap: memoryMb * 1024 * 1024, // Disable swap (swap = memory limit)
          NanoCpus: Math.round(cpus * 1e9),
          PidsLimit: 256,                      // Prevent fork bombs

          // ── Security ────────────────────────────────────────────────────
          SecurityOpt: [
            'no-new-privileges',               // Prevents setuid/setgid escalation
            // Uses Docker's default seccomp profile (blocks ~44 dangerous syscalls)
          ],
          CapDrop: ['ALL'],                    // Drop every Linux capability
          CapAdd: [],                          // Add back none
          ReadonlyRootfs: true,                // Root filesystem is read-only
          AutoRemove: true,                    // Container deleted immediately on exit
        },

        // Disable networking at the container level too (belt-and-suspenders)
        NetworkDisabled: true,

        // No TTY — we capture raw multiplexed streams
        AttachStdout: true,
        AttachStderr: true,
      });

      await container.start();
      logger.debug('Sandbox container started', { id: container.id.slice(0, 12) });

      // ── Collect output via Docker's multiplexed stream protocol ─────────
      // Docker multiplexes stdout and stderr into a single stream with an 8-byte
      // header per chunk: [stream_type(1), 0, 0, 0, size(4-bytes-big-endian)]
      // We must demux manually — the naive "split by \n and alternate" approach
      // in the original code was completely wrong.
      const { stdout, stderr } = await this.collectOutput(container, timeout);

      // container.wait() resolves after the container exits
      const waitResult = await container.wait() as { StatusCode: number };
      const durationMs = Date.now() - start;

      logger.info('Sandbox container exited', {
        exitCode: waitResult.StatusCode,
        durationMs,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
      });

      if (waitResult.StatusCode !== 0) {
        logger.warn('Sandbox command returned non-zero exit', {
          exitCode: waitResult.StatusCode,
          stderr: stderr.slice(0, 500),
        });
      }

      return { stdout, stderr, exitCode: waitResult.StatusCode };

    } catch (err: any) {
      // If the container is still around (e.g. timeout), kill it
      if (container) {
        try {
          await container.kill();
        } catch {
          // Already gone — that's fine
        }
      }
      logger.error('Docker sandbox error', { error: err.message, command: command.slice(0, 100) });
      throw err;
    }
  }

  /**
   * Attach to the container's stdout/stderr streams and collect output,
   * with a hard timeout that kills the container if it runs too long.
   */
  private async collectOutput(
    container: Docker.Container,
    timeout: number
  ): Promise<{ stdout: string; stderr: string }> {
    const MAX_OUTPUT_BYTES = 5 * 1024 * 1024; // 5MB cap per stream

    let stdoutBuf = '';
    let stderrBuf = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    const stream = await container.attach({
      stream: true,
      stdout: true,
      stderr: true,
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(async () => {
        logger.warn('Sandbox container timed out — killing', {
          id: container.id.slice(0, 12),
          timeout,
        });
        try { await container.kill(); } catch { /* already stopped */ }
        reject(new Error(`Sandbox command timed out after ${timeout}ms`));
      }, timeout);

      // Docker's demux utility writes correctly separated stdout/stderr
      container.modem.demuxStream(
        stream,
        new Writable({
          write(chunk, _enc, cb) {
            if (!stdoutTruncated) {
              stdoutBuf += chunk.toString();
              if (stdoutBuf.length > MAX_OUTPUT_BYTES) {
                stdoutBuf = stdoutBuf.slice(0, MAX_OUTPUT_BYTES) + '\n\n[OUTPUT TRUNCATED — exceeded 5MB limit]';
                stdoutTruncated = true;
              }
            }
            cb();
          },
        }),
        new Writable({
          write(chunk, _enc, cb) {
            if (!stderrTruncated) {
              stderrBuf += chunk.toString();
              if (stderrBuf.length > MAX_OUTPUT_BYTES) {
                stderrBuf = stderrBuf.slice(0, MAX_OUTPUT_BYTES) + '\n\n[OUTPUT TRUNCATED — exceeded 5MB limit]';
                stderrTruncated = true;
              }
            }
            cb();
          },
        })
      );

      stream.on('end', () => {
        clearTimeout(timer);
        resolve({ stdout: stdoutBuf, stderr: stderrBuf });
      });

      stream.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private async pullImage(): Promise<void> {
    logger.info('Pulling Docker sandbox image', { image: SANDBOX_IMAGE });
    await new Promise<void>((resolve, reject) => {
      this.docker.pull(SANDBOX_IMAGE, (err: Error | null, stream: any) => {
        if (err) return reject(err);
        this.docker.modem.followProgress(
          stream,
          (err: Error | null) => (err ? reject(err) : resolve()),
          (event: any) => logger.debug('Docker pull progress', { status: event.status })
        );
      });
    });
    logger.info('Docker sandbox image pulled', { image: SANDBOX_IMAGE });
  }
}

