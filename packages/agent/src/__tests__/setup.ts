import * as path from 'path';
import * as os from 'os';

// Set test environment variables before any imports
process.env.ANTHROPIC_API_KEY = 'test-key-for-unit-tests';
process.env.AGENT_DB_PATH = path.join(os.tmpdir(), 'klaus-code-test.db');
process.env.AGENT_LOG_DIR = path.join(os.tmpdir(), 'klaus-code-test-logs');
process.env.LOG_LEVEL = 'error'; // Suppress logs in tests

// Global test timeout
jest.setTimeout(30000);

// Suppress console in tests unless LOG_TEST=true
if (!process.env.LOG_TEST) {
  global.console.log = jest.fn();
  global.console.info = jest.fn();
  global.console.warn = jest.fn();
}
