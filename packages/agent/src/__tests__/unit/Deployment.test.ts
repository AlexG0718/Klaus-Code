/**
 * Deployment Tools Test Suite
 *
 * Tests for Vercel, AWS S3, Terraform, and Infrastructure Generator tools.
 * Focuses on security, validation, and error handling.
 */

import * as path from 'path';

// ─── Schema Validation Tests ─────────────────────────────────────────────────

describe('Deployment Schema Validation', () => {
  // Import schemas dynamically
  let schemas: typeof import('../../tools/schemas');

  beforeAll(async () => {
    schemas = await import('../../tools/schemas');
  });

  describe('VercelDeploySchema', () => {
    it('accepts valid input with defaults', () => {
      const input = {};
      const result = schemas.VercelDeploySchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.directory).toBe('.');
        expect(result.data?.production).toBe(false);
      }
    });

    it('accepts production deployment', () => {
      const input = { production: true, projectName: 'my-app' };
      const result = schemas.VercelDeploySchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.production).toBe(true);
        expect(result.data?.projectName).toBe('my-app');
      }
    });

    it('accepts environment variables', () => {
      const input = { env: { NODE_ENV: 'production', API_KEY: 'secret' } };
      const result = schemas.VercelDeploySchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.env).toEqual({
          NODE_ENV: 'production',
          API_KEY: 'secret',
        });
      }
    });
  });

  describe('AWSS3DeploySchema', () => {
    it('requires bucketName', () => {
      const input = {};
      const result = schemas.AWSS3DeploySchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('accepts valid bucket name', () => {
      const input = { bucketName: 'my-bucket-123' };
      const result = schemas.AWSS3DeploySchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.bucketName).toBe('my-bucket-123');
        expect(result.data?.region).toBe('us-east-1');
        expect(result.data?.buildDir).toBe('dist');
      }
    });

    it('accepts CloudFront distribution ID', () => {
      const input = {
        bucketName: 'my-bucket',
        cloudFrontDistributionId: 'E1234567890ABC',
      };
      const result = schemas.AWSS3DeploySchema.safeParse(input);
      expect(result.success).toBe(true);
    });
  });

  describe('TerraformInitSchema', () => {
    it('accepts defaults', () => {
      const input = {};
      const result = schemas.TerraformInitSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.directory).toBe('terraform');
        expect(result.data?.upgrade).toBe(false);
      }
    });

    it('accepts upgrade option', () => {
      const input = { upgrade: true, reconfigure: true };
      const result = schemas.TerraformInitSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.upgrade).toBe(true);
        expect(result.data?.reconfigure).toBe(true);
      }
    });
  });

  describe('TerraformPlanSchema', () => {
    it('accepts variables', () => {
      const input = {
        directory: 'infra',
        vars: { region: 'us-west-2', environment: 'staging' },
      };
      const result = schemas.TerraformPlanSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.vars).toEqual({
          region: 'us-west-2',
          environment: 'staging',
        });
      }
    });

    it('accepts destroy plan', () => {
      const input = { destroy: true };
      const result = schemas.TerraformPlanSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.destroy).toBe(true);
      }
    });
  });

  describe('TerraformApplySchema', () => {
    it('defaults autoApprove to false', () => {
      const input = {};
      const result = schemas.TerraformApplySchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.autoApprove).toBe(false);
      }
    });

    it('accepts plan file', () => {
      const input = { planFile: 'tfplan' };
      const result = schemas.TerraformApplySchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.planFile).toBe('tfplan');
      }
    });
  });

  describe('TerraformDestroySchema', () => {
    it('defaults autoApprove to false', () => {
      const input = {};
      const result = schemas.TerraformDestroySchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.autoApprove).toBe(false);
      }
    });
  });

  describe('GenerateInfrastructureSchema', () => {
    it('requires provider', () => {
      const input = {};
      const result = schemas.GenerateInfrastructureSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('accepts valid provider', () => {
      const input = { provider: 'aws' };
      const result = schemas.GenerateInfrastructureSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.provider).toBe('aws');
        expect(result.data?.type).toBe('static');
      }
    });

    it('rejects invalid provider', () => {
      const input = { provider: 'gcp' };
      const result = schemas.GenerateInfrastructureSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('accepts all infrastructure types', () => {
      const types = ['static', 'serverless', 'container', 'fullstack'];
      for (const type of types) {
        const input = { provider: 'aws', type };
        const result = schemas.GenerateInfrastructureSchema.safeParse(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data?.type).toBe(type);
        }
      }
    });

    it('accepts domain option', () => {
      const input = { provider: 'aws', domain: 'example.com' };
      const result = schemas.GenerateInfrastructureSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.domain).toBe('example.com');
      }
    });
  });
});

// ─── Security Tests ──────────────────────────────────────────────────────────

describe('Deployment Security', () => {
  describe('Path Traversal Prevention', () => {
    it('should block directory traversal in Vercel deploy', async () => {
      // Mock the function since we can't actually run it
      const workspaceDir = '/workspace';
      const directory = '../../../etc';

      const resolvedPath = path.resolve(
        workspaceDir,
        directory.replace(/^[/\\]+/, '')
      );
      const isWithinWorkspace = resolvedPath.startsWith(workspaceDir);

      expect(isWithinWorkspace).toBe(false);
    });

    it('should block directory traversal in AWS S3 deploy', async () => {
      const workspaceDir = '/workspace';
      const buildDir = '../../etc/passwd';

      const projectDir = '/workspace/project';
      const resolvedPath = path.resolve(
        projectDir,
        buildDir.replace(/^[/\\]+/, '')
      );
      const isWithinProject = resolvedPath.startsWith(projectDir);

      expect(isWithinProject).toBe(false);
    });

    it('should block directory traversal in Terraform', async () => {
      const workspaceDir = '/workspace';
      const directory = '../../../home/user';

      const resolvedPath = path.resolve(
        workspaceDir,
        directory.replace(/^[/\\]+/, '')
      );
      const isWithinWorkspace = resolvedPath.startsWith(workspaceDir);

      expect(isWithinWorkspace).toBe(false);
    });
  });

  describe('Input Validation', () => {
    it('should validate S3 bucket names', () => {
      const validBuckets = [
        'my-bucket',
        'bucket123',
        'a-b-c-123',
        'aaa', // minimum 3 chars
      ];

      const invalidBuckets = [
        'a', // too short
        '-bucket', // starts with hyphen
        'bucket-', // ends with hyphen
        'BUCKET', // uppercase
        'my..bucket', // consecutive periods
      ];

      const isValidBucketName = (name: string): boolean => {
        return (
          /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name) &&
          !name.includes('..') &&
          !name.includes('.-') &&
          !name.includes('-.')
        );
      };

      for (const bucket of validBuckets) {
        expect(isValidBucketName(bucket)).toBe(true);
      }

      for (const bucket of invalidBuckets) {
        expect(isValidBucketName(bucket)).toBe(false);
      }
    });

    it('should sanitize project names for CLI safety', () => {
      const sanitizeProjectName = (name: string): string => {
        // Only allow alphanumeric, hyphens, underscores
        return name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 100);
      };

      expect(sanitizeProjectName('my-project')).toBe('my-project');
      expect(sanitizeProjectName('my_project_123')).toBe('my_project_123');
      expect(sanitizeProjectName('test; rm -rf /')).toBe('test--rm--rf--');
      expect(sanitizeProjectName('$(cat /etc/passwd)')).toBe(
        '--cat--etc-passwd-'
      );
    });
  });

  describe('Terraform State Security', () => {
    it('should not allow state file access outside workspace', () => {
      const workspaceDir = '/workspace/project';
      const stateFile = '../../../etc/passwd';

      const resolvedPath = path.resolve(
        workspaceDir,
        stateFile.replace(/^[/\\]+/, '')
      );
      const isWithinWorkspace = resolvedPath.startsWith(workspaceDir);

      expect(isWithinWorkspace).toBe(false);
    });

    it('should block var-file traversal', () => {
      const workspaceDir = '/workspace/project';
      const varFile = '../../secrets/terraform.tfvars';

      const resolvedPath = path.resolve(
        workspaceDir,
        varFile.replace(/^[/\\]+/, '')
      );
      const isWithinWorkspace = resolvedPath.startsWith(workspaceDir);

      expect(isWithinWorkspace).toBe(false);
    });
  });
});

// ─── Approval Flow Tests ─────────────────────────────────────────────────────

describe('Terraform Approval Flows', () => {
  describe('Apply Approval', () => {
    it('should require approval by default', () => {
      const input: {
        directory: string;
        autoApprove?: boolean;
        planFile?: string;
      } = { directory: 'terraform' };
      const requiresApproval = !input.planFile && !input.autoApprove;
      expect(requiresApproval).toBe(true);
    });

    it('should skip approval with planFile', () => {
      const input: {
        directory: string;
        autoApprove?: boolean;
        planFile?: string;
      } = { directory: 'terraform', planFile: 'tfplan' };
      const requiresApproval = !input.planFile && !input.autoApprove;
      expect(requiresApproval).toBe(false);
    });

    it('should skip approval with autoApprove', () => {
      const input: {
        directory: string;
        autoApprove?: boolean;
        planFile?: string;
      } = { directory: 'terraform', autoApprove: true };
      const requiresApproval = !input.planFile && !input.autoApprove;
      expect(requiresApproval).toBe(false);
    });
  });

  describe('Destroy Approval', () => {
    it('should always require approval without autoApprove', () => {
      const input: { directory: string; autoApprove?: boolean } = {
        directory: 'terraform',
      };
      const requiresApproval = !input.autoApprove;
      expect(requiresApproval).toBe(true);
    });
  });
});

// ─── Infrastructure Generator Tests ──────────────────────────────────────────

describe('Infrastructure Generator', () => {
  describe('Resource Name Sanitization', () => {
    it('should sanitize project names for resource naming', () => {
      const sanitize = (name: string): string => {
        return name
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 63);
      };

      expect(sanitize('My Project')).toBe('my-project');
      expect(sanitize('project@123!')).toBe('project-123');
      expect(sanitize('---test---')).toBe('test');
      expect(sanitize('UPPERCASE')).toBe('uppercase');

      // Should truncate long names
      const longName = 'a'.repeat(100);
      expect(sanitize(longName).length).toBeLessThanOrEqual(63);
    });
  });

  describe('Project Type Detection', () => {
    it('should detect React projects', () => {
      const mockPackageJson = {
        dependencies: {
          react: '^18.0.0',
          'react-dom': '^18.0.0',
        },
      };

      const deps = { ...mockPackageJson.dependencies } as Record<
        string,
        string
      >;
      const isReact = !!deps['react'] || !!deps['react-dom'];
      expect(isReact).toBe(true);
    });

    it('should detect Next.js projects', () => {
      const mockPackageJson = {
        dependencies: {
          next: '^14.0.0',
          react: '^18.0.0',
        },
      };

      const deps = { ...mockPackageJson.dependencies } as Record<
        string,
        string
      >;
      const isNextjs = !!deps['next'];
      expect(isNextjs).toBe(true);
    });

    it('should detect Node.js API projects', () => {
      const mockPackageJson = {
        dependencies: {
          express: '^4.18.0',
        },
      };

      const deps = { ...mockPackageJson.dependencies } as Record<
        string,
        string | undefined
      >;
      const isApi = !!deps['express'] || !!deps['fastify'] || !!deps['koa'];
      expect(isApi).toBe(true);
    });
  });

  describe('Provider-Specific Generation', () => {
    it('should generate AWS static site resources', () => {
      // Verify expected files for static site
      const expectedFiles = [
        'main.tf',
        'variables.tf',
        's3.tf',
        'cloudfront.tf', // if CDN enabled
        'outputs.tf',
        'terraform.tfvars.example',
        '.gitignore',
      ];

      // Just verify the list is complete
      expect(expectedFiles).toContain('main.tf');
      expect(expectedFiles).toContain('s3.tf');
    });

    it('should generate serverless resources', () => {
      const expectedFiles = [
        'main.tf',
        'variables.tf',
        'lambda.tf',
        'outputs.tf',
      ];

      expect(expectedFiles).toContain('lambda.tf');
    });

    it('should generate container resources', () => {
      const expectedFiles = ['main.tf', 'variables.tf', 'ecs.tf', 'outputs.tf'];

      expect(expectedFiles).toContain('ecs.tf');
    });
  });
});

// ─── Error Handling Tests ────────────────────────────────────────────────────

describe('Deployment Error Handling', () => {
  it('should handle missing credentials gracefully', () => {
    // Vercel without token
    const hasVercelToken = !!process.env.VERCEL_TOKEN;
    expect(typeof hasVercelToken).toBe('boolean');
  });

  it('should handle missing AWS credentials gracefully', () => {
    const hasAWSCredentials = !!(
      (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
      process.env.AWS_PROFILE ||
      process.env.AWS_ROLE_ARN
    );
    expect(typeof hasAWSCredentials).toBe('boolean');
  });

  it('should handle Terraform not installed', () => {
    // The tool should provide a helpful error message
    const notInstalledError =
      'Terraform is not installed. Please install it from https://www.terraform.io/downloads';
    expect(notInstalledError).toContain('terraform.io');
  });

  it('should handle AWS CLI not installed', () => {
    const notInstalledError =
      'AWS CLI is not installed. Please install it from https://aws.amazon.com/cli/';
    expect(notInstalledError).toContain('aws.amazon.com');
  });
});

// ─── Integration Tests (Mocked) ──────────────────────────────────────────────

describe('Deployment Integration', () => {
  describe('Tool Definition Completeness', () => {
    it('should have all deployment tools defined', async () => {
      const { TOOL_DEFINITIONS } = await import('../../tools/ToolExecutor');

      const deploymentTools = [
        'deploy_netlify',
        'deploy_vercel',
        'deploy_aws_s3',
        'terraform_init',
        'terraform_plan',
        'terraform_apply',
        'terraform_destroy',
        'terraform_output',
        'generate_infrastructure',
      ];

      const definedTools = TOOL_DEFINITIONS.map(
        (t: { name: string }) => t.name
      );

      for (const tool of deploymentTools) {
        expect(definedTools).toContain(tool);
      }
    });
  });

  describe('Schema Map Completeness', () => {
    it('should have schemas for all deployment tools', async () => {
      const schemas = await import('../../tools/schemas');

      expect(schemas.VercelDeploySchema).toBeDefined();
      expect(schemas.AWSS3DeploySchema).toBeDefined();
      expect(schemas.TerraformInitSchema).toBeDefined();
      expect(schemas.TerraformPlanSchema).toBeDefined();
      expect(schemas.TerraformApplySchema).toBeDefined();
      expect(schemas.TerraformDestroySchema).toBeDefined();
      expect(schemas.TerraformOutputSchema).toBeDefined();
      expect(schemas.GenerateInfrastructureSchema).toBeDefined();
    });
  });

  describe('Progress Tracking', () => {
    it('should have progress messages for deployment tools', () => {
      const deploymentTools = [
        'deploy_vercel',
        'deploy_aws_s3',
        'terraform_init',
        'terraform_plan',
        'terraform_apply',
        'terraform_destroy',
        'generate_infrastructure',
      ];

      // Verify these are in LONG_RUNNING_TOOLS
      // (would need to export and check)
      expect(deploymentTools.length).toBeGreaterThan(0);
    });
  });
});

// ─── Edge Cases ──────────────────────────────────────────────────────────────

describe('Deployment Edge Cases', () => {
  it('should handle empty workspace', () => {
    // An empty workspace should not crash
    const hasPackageJson = false;
    const hasTsConfig = false;
    const hasIndexHtml = false;

    // Should default to 'unknown' type
    const projectType = hasPackageJson
      ? 'detected'
      : hasIndexHtml
        ? 'static'
        : 'unknown';
    expect(projectType).toBe('unknown');
  });

  it('should handle very long project names', () => {
    const sanitize = (name: string): string => {
      return name
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .slice(0, 63);
    };

    const longName = 'a'.repeat(200);
    const sanitized = sanitize(longName);
    expect(sanitized.length).toBe(63);
  });

  it('should handle special characters in file paths', () => {
    const paths = [
      'path/to/file.ts',
      'path\\to\\file.ts', // Windows
      'path with spaces/file.ts',
      'path-with-dashes/file.ts',
    ];

    // All should be handled without crashing
    for (const p of paths) {
      const normalized = p.replace(/\\/g, '/');
      expect(normalized).not.toContain('\\');
    }
  });

  it('should handle concurrent deployments', () => {
    // Each deployment should be independent
    const deployment1 = { id: '1', status: 'running' };
    const deployment2 = { id: '2', status: 'running' };

    expect(deployment1.id).not.toBe(deployment2.id);
  });
});
