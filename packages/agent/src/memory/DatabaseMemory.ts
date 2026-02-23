import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs-extra';
import { logger } from '../logger';

export interface MemoryEntry {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolName?: string;
  toolResult?: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface Session {
  id: string;
  workspaceDir: string;
  summary?: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  pinned: boolean;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface KnowledgeEntry {
  key: string;
  value: string;
  category: string;
  updatedAt: Date;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface FileChangeRecord {
  id: string;
  sessionId: string;
  workspaceDir: string;
  toolName: string;
  filePath: string; // extracted from tool input
  input: string; // raw JSON
  output: string | null;
  success: boolean;
  durationMs: number | null;
  createdAt: Date;
}

// ─── Model pricing ($ per million tokens) ─────────────────────────────────────
// Looked up by prefix so new point releases don't require code changes.
// Falls back to Opus pricing if the model string is unrecognised — better to
// over-estimate cost than under-estimate.
interface ModelPricing {
  input: number;
  output: number;
}

const MODEL_PRICING: Array<{ prefix: string; pricing: ModelPricing }> = [
  { prefix: 'claude-haiku', pricing: { input: 0.8, output: 4.0 } },
  { prefix: 'claude-sonnet', pricing: { input: 3.0, output: 15.0 } },
  { prefix: 'claude-opus', pricing: { input: 15.0, output: 75.0 } },
];

const DEFAULT_PRICING: ModelPricing = { input: 15.0, output: 75.0 }; // Opus fallback

function pricingForModel(model: string): ModelPricing {
  const lower = model.toLowerCase();
  for (const { prefix, pricing } of MODEL_PRICING) {
    if (lower.includes(prefix)) return pricing;
  }
  return DEFAULT_PRICING;
}

function estimateCost(
  inputTokens: number,
  outputTokens: number,
  model?: string
): number {
  const p = model ? pricingForModel(model) : DEFAULT_PRICING;
  return (
    (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output
  );
}

export class DatabaseMemory {
  private db!: Database.Database;

  constructor(private readonly dbPath: string) {}

  async initialize(): Promise<void> {
    await fs.ensureDir(path.dirname(this.dbPath));
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.createSchema();
    logger.info('Memory database initialized', { dbPath: this.dbPath });
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        workspace_dir TEXT NOT NULL,
        summary TEXT,
        total_input_tokens INTEGER NOT NULL DEFAULT 0,
        total_output_tokens INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        tags TEXT DEFAULT '[]',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
        content TEXT NOT NULL,
        tool_name TEXT,
        tool_result TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

      CREATE TABLE IF NOT EXISTS knowledge (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        input TEXT NOT NULL,
        output TEXT,
        success INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(tool_name);

      CREATE TABLE IF NOT EXISTS token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        model TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_token_usage_session ON token_usage(session_id);
    `);

    // Migration: Add pinned and tags columns if they don't exist (for existing databases)
    try {
      this.db.exec(
        `ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`
      );
    } catch {
      /* Column already exists */
    }
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN tags TEXT DEFAULT '[]'`);
    } catch {
      /* Column already exists */
    }
  }

  // ─── Sessions ──────────────────────────────────────────────────────────────

  createSession(id: string, workspaceDir: string): Session {
    this.db
      .prepare('INSERT INTO sessions (id, workspace_dir) VALUES (?, ?)')
      .run(id, workspaceDir);
    logger.debug('Session created', { sessionId: id, workspaceDir });
    return this.getSession(id)!;
  }

  getSession(id: string): Session | undefined {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as any;
    if (!row) return undefined;
    return this.rowToSession(row);
  }

  listSessions(limit = 20): Session[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM sessions ORDER BY pinned DESC, updated_at DESC LIMIT ?'
      )
      .all(limit) as any[];
    return rows.map(this.rowToSession.bind(this));
  }

  searchSessions(query: string, limit = 20): Session[] {
    const like = `%${query}%`;
    // Two-pass approach: first match by session summary (fast, indexed),
    // then match by recent message content with a bounded inner query.
    // This avoids a full table scan across all messages in the database.
    const rows = this.db
      .prepare(
        `
      SELECT * FROM sessions WHERE id IN (
        SELECT id FROM sessions WHERE summary LIKE ?
        UNION
        SELECT DISTINCT session_id FROM (
          SELECT session_id FROM messages
          WHERE content LIKE ?
          ORDER BY created_at DESC
          LIMIT 500
        )
      )
      ORDER BY updated_at DESC
      LIMIT ?
    `
      )
      .all(like, like, limit) as any[];
    return rows.map(this.rowToSession);
  }

  updateSessionSummary(sessionId: string, summary: string): void {
    this.db
      .prepare(
        'UPDATE sessions SET summary = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      )
      .run(summary, sessionId);
  }

  /**
   * Toggle the pinned status of a session.
   * Returns the new pinned status.
   */
  toggleSessionPin(sessionId: string): boolean {
    const session = this.getSession(sessionId);
    if (!session) return false;

    const newPinned = !session.pinned;
    this.db
      .prepare('UPDATE sessions SET pinned = ? WHERE id = ?')
      .run(newPinned ? 1 : 0, sessionId);

    logger.info('Session pin toggled', { sessionId, pinned: newPinned });
    return newPinned;
  }

  /**
   * Set the tags for a session.
   */
  setSessionTags(sessionId: string, tags: string[]): void {
    // Validate and sanitize tags
    const validTags = tags
      .map((t) => t.trim().slice(0, 50)) // Max 50 chars per tag
      .filter((t) => t.length > 0)
      .slice(0, 10); // Max 10 tags

    this.db
      .prepare('UPDATE sessions SET tags = ? WHERE id = ?')
      .run(JSON.stringify(validTags), sessionId);

    logger.info('Session tags updated', { sessionId, tags: validTags });
  }

  /**
   * Add a tag to a session.
   */
  addSessionTag(sessionId: string, tag: string): void {
    const session = this.getSession(sessionId);
    if (!session) return;

    const cleanTag = tag.trim().slice(0, 50);
    if (!cleanTag || session.tags.includes(cleanTag)) return;

    const newTags = [...session.tags, cleanTag].slice(0, 10);
    this.setSessionTags(sessionId, newTags);
  }

  /**
   * Remove a tag from a session.
   */
  removeSessionTag(sessionId: string, tag: string): void {
    const session = this.getSession(sessionId);
    if (!session) return;

    const newTags = session.tags.filter((t) => t !== tag);
    this.setSessionTags(sessionId, newTags);
  }

  private rowToSession(row: any): Session {
    let tags: string[] = [];
    try {
      tags = JSON.parse(row.tags || '[]');
    } catch {
      /* Invalid JSON, use empty array */
    }

    return {
      id: row.id,
      workspaceDir: row.workspace_dir,
      summary: row.summary,
      totalInputTokens: row.total_input_tokens ?? 0,
      totalOutputTokens: row.total_output_tokens ?? 0,
      pinned: Boolean(row.pinned),
      tags,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  // ─── Messages ──────────────────────────────────────────────────────────────

  addMessage(entry: Omit<MemoryEntry, 'createdAt'>): void {
    this.db
      .prepare(
        `
      INSERT INTO messages (id, session_id, role, content, tool_name, tool_result, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        entry.id,
        entry.sessionId,
        entry.role,
        entry.content,
        entry.toolName ?? null,
        entry.toolResult ?? null,
        JSON.stringify(entry.metadata)
      );
    this.db
      .prepare(
        'UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      )
      .run(entry.sessionId);
  }

  getMessages(sessionId: string, limit = 100): MemoryEntry[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?'
      )
      .all(sessionId, limit) as any[];
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      toolName: row.tool_name,
      toolResult: row.tool_result,
      metadata: JSON.parse(row.metadata),
      createdAt: new Date(row.created_at),
    }));
  }

  countMessages(sessionId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as n FROM messages WHERE session_id = ?')
      .get(sessionId) as any;
    return row?.n ?? 0;
  }

  /**
   * Return the N most recent messages for a session, ordered oldest-first.
   * Unlike getMessages (which returns the first N), this returns the LAST N,
   * which is critical for context window management.
   */
  getRecentMessages(sessionId: string, limit = 100): MemoryEntry[] {
    const rows = this.db
      .prepare(
        `
        SELECT * FROM (
          SELECT * FROM messages WHERE session_id = ?
          ORDER BY created_at DESC LIMIT ?
        ) sub ORDER BY created_at ASC
      `
      )
      .all(sessionId, limit) as any[];
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      toolName: row.tool_name,
      toolResult: row.tool_result,
      metadata: JSON.parse(row.metadata),
      createdAt: new Date(row.created_at),
    }));
  }

  // ─── Knowledge ─────────────────────────────────────────────────────────────

  setKnowledge(key: string, value: string, category = 'general'): void {
    this.db
      .prepare(
        `
      INSERT INTO knowledge (key, value, category, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `
      )
      .run(key, value, category);
  }

  getKnowledge(key: string): string | undefined {
    const row = this.db
      .prepare('SELECT value FROM knowledge WHERE key = ?')
      .get(key) as any;
    return row?.value;
  }

  listKnowledge(category?: string): KnowledgeEntry[] {
    const rows = (
      category
        ? this.db
            .prepare('SELECT * FROM knowledge WHERE category = ? ORDER BY key')
            .all(category)
        : this.db.prepare('SELECT * FROM knowledge ORDER BY key').all()
    ) as any[];
    return rows.map((row) => ({
      key: row.key,
      value: row.value,
      category: row.category,
      updatedAt: new Date(row.updated_at),
    }));
  }

  // ─── Tool calls ────────────────────────────────────────────────────────────

  recordToolCall(params: {
    id: string;
    sessionId: string;
    toolName: string;
    input: string;
    output?: string;
    success: boolean;
    durationMs?: number;
  }): void {
    this.db
      .prepare(
        `
      INSERT INTO tool_calls (id, session_id, tool_name, input, output, success, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        params.id,
        params.sessionId,
        params.toolName,
        params.input,
        params.output ?? null,
        params.success ? 1 : 0,
        params.durationMs ?? null
      );
  }

  getToolCallStats(
    sessionId?: string
  ): Record<string, { calls: number; successes: number; avgDuration: number }> {
    const query = sessionId
      ? `SELECT tool_name,
                COUNT(*)                    AS calls,
                SUM(CASE WHEN success THEN 1 ELSE 0 END) AS successes,
                COALESCE(AVG(duration_ms), 0)             AS avg_duration
         FROM tool_calls WHERE session_id = ?
         GROUP BY tool_name`
      : `SELECT tool_name,
                COUNT(*)                    AS calls,
                SUM(CASE WHEN success THEN 1 ELSE 0 END) AS successes,
                COALESCE(AVG(duration_ms), 0)             AS avg_duration
         FROM tool_calls
         GROUP BY tool_name`;

    const rows = (
      sessionId
        ? this.db.prepare(query).all(sessionId)
        : this.db.prepare(query).all()
    ) as any[];

    const stats: Record<
      string,
      { calls: number; successes: number; avgDuration: number }
    > = {};
    for (const row of rows) {
      stats[row.tool_name] = {
        calls: row.calls,
        successes: row.successes,
        avgDuration: Math.round(row.avg_duration),
      };
    }
    return stats;
  }

  /**
   * Delete a single session and its cascading messages, tool calls, and token
   * usage records. Returns true if the session existed and was deleted.
   */
  deleteSession(id: string): boolean {
    const result = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    if (result.changes > 0) {
      logger.info('Session deleted', { sessionId: id });
      return true;
    }
    return false;
  }

  // ─── Token usage ───────────────────────────────────────────────────────────

  recordTokenUsage(
    sessionId: string,
    inputTokens: number,
    outputTokens: number,
    model: string
  ): void {
    this.db
      .prepare(
        `
      INSERT INTO token_usage (session_id, input_tokens, output_tokens, model)
      VALUES (?, ?, ?, ?)
    `
      )
      .run(sessionId, inputTokens, outputTokens, model);

    // Roll up into session totals for fast reads
    this.db
      .prepare(
        `
      UPDATE sessions
      SET total_input_tokens  = total_input_tokens  + ?,
          total_output_tokens = total_output_tokens + ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `
      )
      .run(inputTokens, outputTokens, sessionId);

    logger.debug('Token usage recorded', {
      sessionId,
      inputTokens,
      outputTokens,
      model,
    });
  }

  getSessionTokenUsage(sessionId: string): TokenUsage {
    const rows = this.db
      .prepare(
        `
      SELECT input_tokens, output_tokens, model
      FROM token_usage WHERE session_id = ?
    `
      )
      .all(sessionId) as any[];

    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;

    for (const row of rows) {
      inputTokens += row.input_tokens;
      outputTokens += row.output_tokens;
      costUsd += estimateCost(row.input_tokens, row.output_tokens, row.model);
    }

    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      estimatedCostUsd: costUsd,
    };
  }

  getTotalTokenUsage(): TokenUsage {
    const rows = this.db
      .prepare(
        `
      SELECT input_tokens, output_tokens, model
      FROM token_usage
    `
      )
      .all() as any[];

    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;

    for (const row of rows) {
      inputTokens += row.input_tokens;
      outputTokens += row.output_tokens;
      costUsd += estimateCost(row.input_tokens, row.output_tokens, row.model);
    }

    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      estimatedCostUsd: costUsd,
    };
  }

  // ─── Database maintenance ──────────────────────────────────────────────────

  /**
   * Return all tool calls for a session (or all sessions) that mutated files,
   * in chronological order. Parses the JSON input field to extract the file
   * path so callers don't have to.
   *
   * FILE_MUTATING_TOOLS are the tools whose execution changes the workspace —
   * used to build the change history view.
   */
  getFileChanges(sessionId?: string): FileChangeRecord[] {
    const FILE_MUTATING_TOOLS = [
      'write_file',
      'apply_patch',
      'delete_file',
      'git_checkpoint',
    ];
    const placeholders = FILE_MUTATING_TOOLS.map(() => '?').join(', ');

    const rows = (
      sessionId
        ? this.db
            .prepare(
              `SELECT tc.*, s.workspace_dir
           FROM tool_calls tc
           JOIN sessions s ON s.id = tc.session_id
           WHERE tc.session_id = ?
             AND tc.tool_name IN (${placeholders})
           ORDER BY tc.created_at ASC`
            )
            .all(sessionId, ...FILE_MUTATING_TOOLS)
        : this.db
            .prepare(
              `SELECT tc.*, s.workspace_dir
           FROM tool_calls tc
           JOIN sessions s ON s.id = tc.session_id
           WHERE tc.tool_name IN (${placeholders})
           ORDER BY tc.created_at ASC`
            )
            .all(...FILE_MUTATING_TOOLS)
    ) as any[];

    return rows.map((row): FileChangeRecord => {
      let input: Record<string, any> = {};
      try {
        input = JSON.parse(row.input);
      } catch {
        /* invalid JSON, use empty */
      }

      // Extract a human-readable file path from each tool's input shape
      const filePath: string =
        input.path ?? // write_file, delete_file
        input.file ?? // apply_patch
        input.message ?? // git_checkpoint — show commit message instead
        '(unknown)';

      return {
        id: row.id,
        sessionId: row.session_id,
        workspaceDir: row.workspace_dir,
        toolName: row.tool_name,
        filePath,
        input: row.input,
        output: row.output ?? null,
        success: Boolean(row.success),
        durationMs: row.duration_ms ?? null,
        createdAt: new Date(row.created_at),
      };
    });
  }

  /**
   * Delete a single knowledge entry by key.
   * Returns true if the entry existed and was deleted.
   */
  deleteKnowledge(key: string): boolean {
    const result = this.db
      .prepare('DELETE FROM knowledge WHERE key = ?')
      .run(key);
    return result.changes > 0;
  }

  /**
   * Delete all sessions and their cascading messages, tool calls, and token
   * usage records. Knowledge entries are NOT touched.
   * Returns the number of sessions deleted.
   */
  clearSessions(): number {
    const result = this.db.prepare('DELETE FROM sessions').run();
    logger.info('Cleared all sessions', { deleted: result.changes });
    return result.changes;
  }

  /**
   * Delete sessions that have been idle longer than the given TTL.
   * A session is considered idle if its updated_at timestamp is older than (now - ttlMs).
   * Returns the number of sessions expired.
   */
  expireIdleSessions(ttlMs: number): number {
    if (ttlMs <= 0) return 0; // TTL disabled

    const cutoff = new Date(Date.now() - ttlMs).toISOString();
    const result = this.db
      .prepare('DELETE FROM sessions WHERE updated_at < ?')
      .run(cutoff);

    if (result.changes > 0) {
      logger.info('Expired idle sessions', {
        deleted: result.changes,
        ttlMs,
        cutoff,
      });
    }

    return result.changes;
  }

  /**
   * Delete all knowledge entries, optionally filtered to a single category.
   * Sessions are NOT touched.
   * Returns the number of entries deleted.
   */
  clearKnowledge(category?: string): number {
    const result = category
      ? this.db
          .prepare('DELETE FROM knowledge WHERE category = ?')
          .run(category)
      : this.db.prepare('DELETE FROM knowledge').run();
    logger.info('Cleared knowledge', {
      category: category ?? 'all',
      deleted: result.changes,
    });
    return result.changes;
  }

  /**
   * Delete everything — sessions, messages, tool calls, token usage, and
   * knowledge. Equivalent to a fresh database, but without dropping the schema.
   */
  clearAll(): { sessions: number; knowledge: number } {
    const sessions = this.clearSessions(); // cascades to messages/tool_calls/token_usage
    const knowledge = this.clearKnowledge();
    logger.info('Database cleared', { sessions, knowledge });
    return { sessions, knowledge };
  }

  /**
   * Return a quick summary of what is in the database — useful before
   * deciding what to clear.
   */
  stats(): {
    sessions: number;
    messages: number;
    toolCalls: number;
    knowledge: number;
    totalCostUsd: number;
  } {
    const count = (sql: string) =>
      (this.db.prepare(sql).get() as any)['COUNT(*)'] as number;

    const usage = this.getTotalTokenUsage();

    return {
      sessions: count('SELECT COUNT(*) FROM sessions'),
      messages: count('SELECT COUNT(*) FROM messages'),
      toolCalls: count('SELECT COUNT(*) FROM tool_calls'),
      knowledge: count('SELECT COUNT(*) FROM knowledge'),
      totalCostUsd: usage.estimatedCostUsd,
    };
  }

  close(): void {
    this.db.close();
  }
}
