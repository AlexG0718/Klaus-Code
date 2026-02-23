/**
 * E2E Tests - Full Agent Workflow
 *
 * These tests simulate complete agent workflows without calling the real Claude API.
 * They test the integration of all components working together.
 *
 * NOTE: Set ANTHROPIC_API_KEY and E2E=true environment variables to run against real API.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import { ToolExecutor } from '../../tools/ToolExecutor';
import { DatabaseMemory } from '../../memory/DatabaseMemory';
import { GitTool } from '../../tools/GitTool';
import type { Config } from '../../config';

const REAL_API = process.env.E2E === 'true' && !!process.env.ANTHROPIC_API_KEY;

describe('E2E - Agent Workflow', () => {
  let workspace: string;
  let dbPath: string;
  let memory: DatabaseMemory;
  let executor: ToolExecutor;
  let git: GitTool;

  const config: Config = {
    apiKey: process.env.ANTHROPIC_API_KEY || 'test-key',
    workspaceDir: '',
    dbPath: '',
    logDir: os.tmpdir(),
    model: 'claude-opus-4-5',
    maxTokens: 8192,
    maxRetries: 3,
    dockerEnabled: false,
    allowedCommands: ['npm', 'npx', 'node', 'echo', 'sh', 'ls', 'cat', 'mkdir', 'git'],
    port: 3001,
  };

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-e2e-'));
    dbPath = path.join(os.tmpdir(), `e2e-${Date.now()}.db`);

    memory = new DatabaseMemory(dbPath);
    await memory.initialize();
    memory.createSession('e2e-session', workspace);

    executor = new ToolExecutor(
      { ...config, workspaceDir: workspace, dbPath },
      memory,
      'e2e-session'
    );

    git = new GitTool(workspace);
    await git.ensureRepo();
  });

  afterEach(async () => {
    memory.close();
    await fs.remove(workspace);
    await fs.remove(dbPath);
  });

  describe('Complete Build Workflow', () => {
    it('should: write files → git checkpoint → verify files exist', async () => {
      // 1. Write a TypeScript component
      const writeResult = await executor.execute({
        name: 'write_file',
        input: {
          path: 'src/Button.tsx',
          content: `import React from 'react';

interface ButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export const Button: React.FC<ButtonProps> = ({ label, onClick, disabled = false }) => {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="px-4 py-2 bg-blue-600 text-white rounded"
    >
      {label}
    </button>
  );
};
`,
        },
      });

      expect(writeResult.success).toBe(true);

      // 2. Write test file
      const testWrite = await executor.execute({
        name: 'write_file',
        input: {
          path: 'src/Button.test.tsx',
          content: `import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from './Button';

describe('Button', () => {
  it('renders label', () => {
    render(<Button label="Click me" onClick={() => {}} />);
    expect(screen.getByText('Click me')).toBeInTheDocument();
  });

  it('calls onClick when clicked', () => {
    const onClick = jest.fn();
    render(<Button label="Test" onClick={onClick} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is disabled when disabled prop is true', () => {
    render(<Button label="Disabled" onClick={() => {}} disabled />);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
`,
        },
      });

      expect(testWrite.success).toBe(true);

      // 3. Git checkpoint
      const checkpoint = await executor.execute({
        name: 'git_checkpoint',
        input: { message: 'Add Button component with tests' },
      });

      expect(checkpoint.success).toBe(true);

      // 4. Verify files exist
      const listResult = await executor.execute({
        name: 'list_files',
        input: { directory: 'src', pattern: '**/*.tsx' },
      });

      expect(listResult.success).toBe(true);
      expect((listResult.result as string[]).length).toBe(2);

      // 5. Verify git status (should be clean after checkpoint)
      const statusResult = await executor.execute({
        name: 'git_status',
        input: {},
      });

      expect(statusResult.success).toBe(true);
    });

    it('should apply patch-based diff instead of full rewrite', async () => {
      // Setup: write initial file
      await executor.execute({
        name: 'write_file',
        input: {
          path: 'src/utils.ts',
          content: `export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
`,
        },
      });

      // Apply patch to add new function
      const patch = `--- src/utils.ts
+++ src/utils.ts
@@ -5,3 +5,7 @@
 export function multiply(a: number, b: number): number {
   return a * b;
 }
+
+export function subtract(a: number, b: number): number {
+  return a - b;
+}
`;

      const patchResult = await executor.execute({
        name: 'apply_patch',
        input: { path: 'src/utils.ts', patch },
      });

      expect(patchResult.success).toBe(true);

      // Verify the new function was added
      const readResult = await executor.execute({
        name: 'read_file',
        input: { path: 'src/utils.ts' },
      });

      expect((readResult.result as any).content).toContain('subtract');
      expect((readResult.result as any).content).toContain('add');
      expect((readResult.result as any).content).toContain('multiply');
    });

    it('should maintain persistent memory across executor instances', async () => {
      // Store knowledge
      await executor.execute({
        name: 'memory_set',
        input: {
          key: 'project.architecture',
          value: 'React + TypeScript + TanStack Query + Zod',
          category: 'project',
        },
      });

      // Create new executor (simulating new session)
      const executor2 = new ToolExecutor(
        { ...config, workspaceDir: workspace, dbPath },
        memory,
        'e2e-session-2'
      );
      memory.createSession('e2e-session-2', workspace);

      // Knowledge should persist
      const getResult = await executor2.execute({
        name: 'memory_get',
        input: { key: 'project.architecture' },
      });

      expect(getResult.success).toBe(true);
      expect((getResult.result as any).value).toContain('TanStack Query');
    });
  });

  describe('Git Workflow E2E', () => {
    it('should create checkpoint and show in diff', async () => {
      // Write a file
      await executor.execute({
        name: 'write_file',
        input: { path: 'README.md', content: '# My Project\n' },
      });

      // Create checkpoint
      await executor.execute({
        name: 'git_checkpoint',
        input: { message: 'Initial commit' },
      });

      // Modify the file
      await executor.execute({
        name: 'apply_patch',
        input: {
          path: 'README.md',
          patch: `--- README.md
+++ README.md
@@ -1 +1,3 @@
 # My Project
+
+This is an AI-built project.
`,
        },
      });

      // Get diff
      const diffResult = await executor.execute({
        name: 'git_diff',
        input: { staged: false },
      });

      expect(diffResult.success).toBe(true);
      expect((diffResult.result as string)).toContain('AI-built');
    });
  });
});
