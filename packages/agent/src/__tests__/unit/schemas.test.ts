import {
  ReadFileSchema,
  WriteFileSchema,
  GitCheckpointSchema,
  RunTestsSchema,
  MemorySetSchema,
  DeploySchema,
} from '../../tools/schemas';

describe('Tool Schemas - Zod Validation Unit Tests', () => {
  describe('ReadFileSchema', () => {
    it('should accept valid path', () => {
      const result = ReadFileSchema.safeParse({ path: 'src/index.ts' });
      expect(result.success).toBe(true);
    });

    it('should default encoding to utf8', () => {
      const result = ReadFileSchema.safeParse({ path: 'test.ts' });
      expect(result.success && result.data.encoding).toBe('utf8');
    });

    it('should reject empty path', () => {
      const result = ReadFileSchema.safeParse({ path: '' });
      expect(result.success).toBe(false);
    });

    it('should reject missing path', () => {
      const result = ReadFileSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('should accept valid encoding options', () => {
      ['utf8', 'base64', 'hex'].forEach((encoding) => {
        const result = ReadFileSchema.safeParse({ path: 'test.ts', encoding });
        expect(result.success).toBe(true);
      });
    });

    it('should reject invalid encoding', () => {
      const result = ReadFileSchema.safeParse({
        path: 'test.ts',
        encoding: 'ascii',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('WriteFileSchema', () => {
    it('should accept valid input', () => {
      const result = WriteFileSchema.safeParse({
        path: 'src/component.tsx',
        content: 'export const Foo = () => <div/>;',
      });
      expect(result.success).toBe(true);
    });

    it('should default createDirs to true', () => {
      const result = WriteFileSchema.safeParse({
        path: 'test.ts',
        content: '',
      });
      expect(result.success && result.data.createDirs).toBe(true);
    });
  });

  describe('GitCheckpointSchema', () => {
    it('should require commit message', () => {
      const result = GitCheckpointSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('should reject empty message', () => {
      const result = GitCheckpointSchema.safeParse({ message: '' });
      expect(result.success).toBe(false);
    });

    it('should accept valid message', () => {
      const result = GitCheckpointSchema.safeParse({
        message: 'Add login component with tests',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('RunTestsSchema', () => {
    it('should default type to all', () => {
      const result = RunTestsSchema.safeParse({});
      expect(result.success && result.data.type).toBe('all');
    });

    it('should accept valid test types', () => {
      ['unit', 'integration', 'e2e', 'all'].forEach((type) => {
        const result = RunTestsSchema.safeParse({ type });
        expect(result.success).toBe(true);
      });
    });

    it('should reject invalid test type', () => {
      const result = RunTestsSchema.safeParse({ type: 'snapshot' });
      expect(result.success).toBe(false);
    });
  });

  describe('MemorySetSchema', () => {
    it('should require key and value', () => {
      expect(MemorySetSchema.safeParse({}).success).toBe(false);
      expect(MemorySetSchema.safeParse({ key: 'k' }).success).toBe(false);
    });

    it('should default category to general', () => {
      const result = MemorySetSchema.safeParse({ key: 'k', value: 'v' });
      expect(result.success && result.data.category).toBe('general');
    });
  });

  describe('DeploySchema', () => {
    it('should have sensible defaults', () => {
      const result = DeploySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.buildCommand).toBe('npm run build');
        expect(result.data.publishDir).toBe('dist');
        expect(result.data.environment).toBe('preview');
      }
    });

    it('should reject invalid environment', () => {
      const result = DeploySchema.safeParse({ environment: 'staging' });
      expect(result.success).toBe(false);
    });
  });
});
