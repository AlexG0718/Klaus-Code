/**
 * Infrastructure Generator Tool
 * 
 * Analyzes a project and generates appropriate Terraform configurations
 * for deployment to AWS, Vercel, or Netlify.
 * 
 * Security:
 * - Path traversal protection
 * - No execution of generated code (generates files only)
 * - Sanitized resource naming
 * - Sensitive values use Terraform variables (not hardcoded)
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import { logger } from '../logger';
import type { GenerateInfrastructureInput } from './schemas';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface InfrastructureResult {
  success: boolean;
  filesGenerated: string[];
  projectType?: string;
  provider: string;
  infrastructureType: string;
  instructions?: string;
  error?: string;
}

interface ProjectAnalysis {
  type: 'react' | 'nextjs' | 'vue' | 'angular' | 'node-api' | 'static' | 'unknown';
  hasPackageJson: boolean;
  hasTsConfig: boolean;
  buildCommand?: string;
  outputDir?: string;
  framework?: string;
  runtime?: string;
}

// ─── Project Analysis ────────────────────────────────────────────────────────

async function analyzeProject(projectDir: string): Promise<ProjectAnalysis> {
  const analysis: ProjectAnalysis = {
    type: 'unknown',
    hasPackageJson: false,
    hasTsConfig: false,
  };

  // Check for package.json
  const packageJsonPath = path.join(projectDir, 'package.json');
  if (await fs.pathExists(packageJsonPath)) {
    analysis.hasPackageJson = true;
    
    try {
      const pkg = await fs.readJson(packageJsonPath);
      
      // Detect framework from dependencies
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      
      if (deps['next']) {
        analysis.type = 'nextjs';
        analysis.framework = 'Next.js';
        analysis.buildCommand = 'npm run build';
        analysis.outputDir = '.next';
      } else if (deps['react'] || deps['react-dom']) {
        analysis.type = 'react';
        analysis.framework = 'React';
        analysis.buildCommand = 'npm run build';
        analysis.outputDir = deps['vite'] ? 'dist' : 'build';
      } else if (deps['vue']) {
        analysis.type = 'vue';
        analysis.framework = 'Vue';
        analysis.buildCommand = 'npm run build';
        analysis.outputDir = 'dist';
      } else if (deps['@angular/core']) {
        analysis.type = 'angular';
        analysis.framework = 'Angular';
        analysis.buildCommand = 'npm run build';
        analysis.outputDir = 'dist';
      } else if (deps['express'] || deps['fastify'] || deps['koa'] || deps['hapi']) {
        analysis.type = 'node-api';
        analysis.framework = 'Node.js API';
        analysis.runtime = 'nodejs20.x';
      } else if (pkg.scripts?.build) {
        analysis.type = 'static';
        analysis.buildCommand = 'npm run build';
        analysis.outputDir = 'dist';
      }

      // Check for custom build/output in package.json
      if (pkg.scripts?.build && !analysis.buildCommand) {
        analysis.buildCommand = 'npm run build';
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Check for tsconfig
  if (await fs.pathExists(path.join(projectDir, 'tsconfig.json'))) {
    analysis.hasTsConfig = true;
  }

  // Check for index.html (static site)
  if (await fs.pathExists(path.join(projectDir, 'index.html'))) {
    if (analysis.type === 'unknown') {
      analysis.type = 'static';
      analysis.outputDir = '.';
    }
  }

  return analysis;
}

// ─── Resource Name Sanitization ──────────────────────────────────────────────

function sanitizeResourceName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63);
}

// ─── Main Export ─────────────────────────────────────────────────────────────

export async function generateInfrastructure(
  input: GenerateInfrastructureInput,
  workspaceDir: string
): Promise<InfrastructureResult> {
  const {
    directory = '.',
    provider,
    type = 'static',
    outputDir = 'terraform',
    projectName,
    domain,
    options = {},
  } = input;

  // ── Security: Validate directories ──────────────────────────────────────────
  const projectDir = path.resolve(workspaceDir, directory.replace(/^[/\\]+/, ''));
  const workspacePrefix = workspaceDir.endsWith(path.sep) ? workspaceDir : workspaceDir + path.sep;
  
  if (!projectDir.startsWith(workspacePrefix) && projectDir !== workspaceDir) {
    return {
      success: false,
      filesGenerated: [],
      provider,
      infrastructureType: type,
      error: `Directory "${directory}" is outside the workspace.`,
    };
  }

  const tfDir = path.resolve(projectDir, outputDir.replace(/^[/\\]+/, ''));
  if (!tfDir.startsWith(projectDir)) {
    return {
      success: false,
      filesGenerated: [],
      provider,
      infrastructureType: type,
      error: `Output directory "${outputDir}" is outside the project.`,
    };
  }

  // ── Analyze project ─────────────────────────────────────────────────────────
  const analysis = await analyzeProject(projectDir);
  
  logger.info('Analyzed project for infrastructure generation', {
    projectType: analysis.type,
    framework: analysis.framework,
    provider,
    type,
  });

  // ── Determine project name ──────────────────────────────────────────────────
  let resolvedProjectName = projectName;
  if (!resolvedProjectName) {
    try {
      const pkg = await fs.readJson(path.join(projectDir, 'package.json'));
      resolvedProjectName = pkg.name;
    } catch {
      resolvedProjectName = path.basename(projectDir);
    }
  }
  resolvedProjectName = sanitizeResourceName(resolvedProjectName || 'project');

  // ── Generate infrastructure files ───────────────────────────────────────────
  await fs.ensureDir(tfDir);
  const filesGenerated: string[] = [];

  switch (provider) {
    case 'aws':
      await generateAWSInfrastructure(
        tfDir,
        resolvedProjectName,
        type,
        analysis,
        domain,
        options,
        filesGenerated
      );
      break;
    
    case 'vercel':
      await generateVercelConfig(
        projectDir,
        resolvedProjectName,
        analysis,
        filesGenerated
      );
      break;
    
    case 'netlify':
      await generateNetlifyConfig(
        projectDir,
        resolvedProjectName,
        analysis,
        filesGenerated
      );
      break;
  }

  // ── Generate instructions ───────────────────────────────────────────────────
  const instructions = generateInstructions(provider, type, tfDir, resolvedProjectName);

  logger.info('Infrastructure generated', {
    provider,
    type,
    filesGenerated: filesGenerated.length,
    projectName: resolvedProjectName,
  });

  return {
    success: true,
    filesGenerated,
    projectType: analysis.type,
    provider,
    infrastructureType: type,
    instructions,
  };
}

// ─── AWS Infrastructure Generation ───────────────────────────────────────────

async function generateAWSInfrastructure(
  tfDir: string,
  projectName: string,
  type: string,
  analysis: ProjectAnalysis,
  domain: string | undefined,
  options: any,
  filesGenerated: string[]
): Promise<void> {
  const {
    enableCdn = true,
    enableHttps = true,
    enableWaf = false,
    runtime = 'nodejs20.x',
    memory = 512,
    timeout = 30,
  } = options;

  // ── main.tf ─────────────────────────────────────────────────────────────────
  const mainTf = `# Generated by Klaus-Code Infrastructure Generator
# Project: ${projectName}
# Type: ${type}

terraform {
  required_version = ">= 1.0"
  
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  
  # Uncomment to use remote state
  # backend "s3" {
  #   bucket = "your-terraform-state-bucket"
  #   key    = "${projectName}/terraform.tfstate"
  #   region = var.aws_region
  # }
}

provider "aws" {
  region = var.aws_region
  
  default_tags {
    tags = {
      Project     = "${projectName}"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

${enableHttps && domain ? `
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"  # Required for CloudFront ACM certificates
}
` : ''}
`;

  await fs.writeFile(path.join(tfDir, 'main.tf'), mainTf);
  filesGenerated.push('main.tf');

  // ── variables.tf ────────────────────────────────────────────────────────────
  const variablesTf = `# Variables for ${projectName}

variable "aws_region" {
  description = "AWS region for resources"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name (e.g., production, staging)"
  type        = string
  default     = "production"
}

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
  default     = "${projectName}"
}

${domain ? `
variable "domain_name" {
  description = "Custom domain name"
  type        = string
  default     = "${domain}"
}
` : ''}

${type === 'serverless' || type === 'fullstack' ? `
variable "lambda_memory" {
  description = "Lambda function memory in MB"
  type        = number
  default     = ${memory}
}

variable "lambda_timeout" {
  description = "Lambda function timeout in seconds"
  type        = number
  default     = ${timeout}
}
` : ''}
`;

  await fs.writeFile(path.join(tfDir, 'variables.tf'), variablesTf);
  filesGenerated.push('variables.tf');

  // ── Type-specific resources ─────────────────────────────────────────────────
  if (type === 'static') {
    await generateStaticSiteResources(tfDir, projectName, enableCdn, enableHttps, enableWaf, domain, filesGenerated);
  } else if (type === 'serverless') {
    await generateServerlessResources(tfDir, projectName, runtime, analysis, filesGenerated);
  } else if (type === 'container') {
    await generateContainerResources(tfDir, projectName, filesGenerated);
  } else if (type === 'fullstack') {
    await generateStaticSiteResources(tfDir, projectName, enableCdn, enableHttps, enableWaf, domain, filesGenerated);
    await generateServerlessResources(tfDir, projectName, runtime, analysis, filesGenerated);
  }

  // ── outputs.tf ──────────────────────────────────────────────────────────────
  const outputsTf = `# Outputs for ${projectName}

${type === 'static' || type === 'fullstack' ? `
output "s3_bucket_name" {
  description = "S3 bucket name for static assets"
  value       = aws_s3_bucket.static_site.id
}

output "s3_bucket_website_url" {
  description = "S3 bucket website URL"
  value       = aws_s3_bucket_website_configuration.static_site.website_endpoint
}

${enableCdn ? `
output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID"
  value       = aws_cloudfront_distribution.cdn.id
}

output "cloudfront_domain_name" {
  description = "CloudFront distribution domain name"
  value       = aws_cloudfront_distribution.cdn.domain_name
}

output "website_url" {
  description = "Website URL"
  value       = "https://\${aws_cloudfront_distribution.cdn.domain_name}"
}
` : ''}
` : ''}

${type === 'serverless' || type === 'fullstack' ? `
output "api_gateway_url" {
  description = "API Gateway URL"
  value       = aws_apigatewayv2_api.api.api_endpoint
}

output "lambda_function_name" {
  description = "Lambda function name"
  value       = aws_lambda_function.api.function_name
}
` : ''}
`;

  await fs.writeFile(path.join(tfDir, 'outputs.tf'), outputsTf);
  filesGenerated.push('outputs.tf');

  // ── terraform.tfvars.example ────────────────────────────────────────────────
  const tfvarsExample = `# Example variable values
# Copy to terraform.tfvars and customize

aws_region   = "us-east-1"
environment  = "production"
project_name = "${projectName}"
${domain ? `domain_name  = "${domain}"` : '# domain_name = "example.com"'}
`;

  await fs.writeFile(path.join(tfDir, 'terraform.tfvars.example'), tfvarsExample);
  filesGenerated.push('terraform.tfvars.example');

  // ── .gitignore ──────────────────────────────────────────────────────────────
  const gitignore = `# Terraform
*.tfstate
*.tfstate.*
*.tfvars
!terraform.tfvars.example
.terraform/
.terraform.lock.hcl
tfplan
crash.log
override.tf
override.tf.json
*_override.tf
*_override.tf.json
`;

  await fs.writeFile(path.join(tfDir, '.gitignore'), gitignore);
  filesGenerated.push('.gitignore');
}

// ─── Static Site Resources ───────────────────────────────────────────────────

async function generateStaticSiteResources(
  tfDir: string,
  projectName: string,
  enableCdn: boolean,
  enableHttps: boolean,
  enableWaf: boolean,
  domain: string | undefined,
  filesGenerated: string[]
): Promise<void> {
  const s3Tf = `# S3 Static Site Hosting

resource "aws_s3_bucket" "static_site" {
  bucket = "\${var.project_name}-\${var.environment}-static"
}

resource "aws_s3_bucket_website_configuration" "static_site" {
  bucket = aws_s3_bucket.static_site.id
  
  index_document {
    suffix = "index.html"
  }
  
  error_document {
    key = "index.html"  # For SPA routing
  }
}

resource "aws_s3_bucket_public_access_block" "static_site" {
  bucket = aws_s3_bucket.static_site.id
  
  block_public_acls       = ${enableCdn ? 'true' : 'false'}
  block_public_policy     = ${enableCdn ? 'true' : 'false'}
  ignore_public_acls      = ${enableCdn ? 'true' : 'false'}
  restrict_public_buckets = ${enableCdn ? 'true' : 'false'}
}

${enableCdn ? `
# CloudFront Origin Access Control
resource "aws_cloudfront_origin_access_control" "static_site" {
  name                              = "\${var.project_name}-oac"
  description                       = "OAC for \${var.project_name}"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_s3_bucket_policy" "static_site" {
  bucket = aws_s3_bucket.static_site.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowCloudFrontAccess"
        Effect    = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "\${aws_s3_bucket.static_site.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.cdn.arn
          }
        }
      }
    ]
  })
}
` : `
resource "aws_s3_bucket_policy" "static_site" {
  bucket = aws_s3_bucket.static_site.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "PublicReadGetObject"
        Effect    = "Allow"
        Principal = "*"
        Action    = "s3:GetObject"
        Resource  = "\${aws_s3_bucket.static_site.arn}/*"
      }
    ]
  })
}
`}
`;

  await fs.writeFile(path.join(tfDir, 's3.tf'), s3Tf);
  filesGenerated.push('s3.tf');

  if (enableCdn) {
    const cloudfrontTf = `# CloudFront CDN Distribution

resource "aws_cloudfront_distribution" "cdn" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  comment             = "\${var.project_name} CDN"
  price_class         = "PriceClass_100"  # US, Canada, Europe
  
  origin {
    domain_name              = aws_s3_bucket.static_site.bucket_regional_domain_name
    origin_id                = "S3-\${var.project_name}"
    origin_access_control_id = aws_cloudfront_origin_access_control.static_site.id
  }
  
  default_cache_behavior {
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3-\${var.project_name}"
    
    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }
    
    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 3600
    max_ttl                = 86400
    compress               = true
  }
  
  # SPA routing - return index.html for 404s
  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }
  
  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }
  
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
  
  viewer_certificate {
    cloudfront_default_certificate = true
  }
  
  ${enableWaf ? `web_acl_id = aws_wafv2_web_acl.cdn.arn` : ''}
}
`;

    await fs.writeFile(path.join(tfDir, 'cloudfront.tf'), cloudfrontTf);
    filesGenerated.push('cloudfront.tf');
  }

  if (enableWaf) {
    const wafTf = `# AWS WAF for CloudFront

resource "aws_wafv2_web_acl" "cdn" {
  name        = "\${var.project_name}-waf"
  description = "WAF for \${var.project_name}"
  scope       = "CLOUDFRONT"
  provider    = aws.us_east_1  # WAF for CloudFront must be in us-east-1
  
  default_action {
    allow {}
  }
  
  # Rate limiting rule
  rule {
    name     = "RateLimitRule"
    priority = 1
    
    override_action {
      none {}
    }
    
    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"
      }
    }
    
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "\${var.project_name}-rate-limit"
      sampled_requests_enabled   = true
    }
  }
  
  # AWS Managed Rules - Common Rule Set
  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 2
    
    override_action {
      none {}
    }
    
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "\${var.project_name}-common-rules"
      sampled_requests_enabled   = true
    }
  }
  
  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "\${var.project_name}-waf"
    sampled_requests_enabled   = true
  }
}
`;

    await fs.writeFile(path.join(tfDir, 'waf.tf'), wafTf);
    filesGenerated.push('waf.tf');
  }
}

// ─── Serverless Resources ────────────────────────────────────────────────────

async function generateServerlessResources(
  tfDir: string,
  projectName: string,
  runtime: string,
  analysis: ProjectAnalysis,
  filesGenerated: string[]
): Promise<void> {
  const lambdaTf = `# Lambda Function and API Gateway

# IAM Role for Lambda
resource "aws_iam_role" "lambda" {
  name = "\${var.project_name}-lambda-role"
  
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Lambda Function
resource "aws_lambda_function" "api" {
  filename         = "\${path.module}/lambda.zip"
  function_name    = "\${var.project_name}-api"
  role             = aws_iam_role.lambda.arn
  handler          = "index.handler"
  source_code_hash = filebase64sha256("\${path.module}/lambda.zip")
  runtime          = "${runtime}"
  memory_size      = var.lambda_memory
  timeout          = var.lambda_timeout
  
  environment {
    variables = {
      NODE_ENV = var.environment
    }
  }
}

# API Gateway
resource "aws_apigatewayv2_api" "api" {
  name          = "\${var.project_name}-api"
  protocol_type = "HTTP"
  
  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    allow_headers = ["Content-Type", "Authorization"]
    max_age       = 300
  }
}

resource "aws_apigatewayv2_stage" "api" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = var.environment
  auto_deploy = true
  
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      ip             = "$context.identity.sourceIp"
      requestTime    = "$context.requestTime"
      httpMethod     = "$context.httpMethod"
      routeKey       = "$context.routeKey"
      status         = "$context.status"
      responseLength = "$context.responseLength"
    })
  }
}

resource "aws_apigatewayv2_integration" "api" {
  api_id             = aws_apigatewayv2_api.api.id
  integration_type   = "AWS_PROXY"
  integration_uri    = aws_lambda_function.api.invoke_arn
  integration_method = "POST"
}

resource "aws_apigatewayv2_route" "api" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "$default"
  target    = "integrations/\${aws_apigatewayv2_integration.api.id}"
}

resource "aws_lambda_permission" "api" {
  statement_id  = "AllowAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "\${aws_apigatewayv2_api.api.execution_arn}/*/*"
}

# CloudWatch Log Group
resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/apigateway/\${var.project_name}"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/\${var.project_name}-api"
  retention_in_days = 14
}
`;

  await fs.writeFile(path.join(tfDir, 'lambda.tf'), lambdaTf);
  filesGenerated.push('lambda.tf');
}

// ─── Container Resources ─────────────────────────────────────────────────────

async function generateContainerResources(
  tfDir: string,
  projectName: string,
  filesGenerated: string[]
): Promise<void> {
  const ecsTf = `# ECS Fargate Deployment

# ECR Repository
resource "aws_ecr_repository" "app" {
  name                 = var.project_name
  image_tag_mutability = "MUTABLE"
  
  image_scanning_configuration {
    scan_on_push = true
  }
}

# ECS Cluster
resource "aws_ecs_cluster" "main" {
  name = "\${var.project_name}-cluster"
  
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# ECS Task Definition
resource "aws_ecs_task_definition" "app" {
  family                   = var.project_name
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn
  
  container_definitions = jsonencode([
    {
      name      = var.project_name
      image     = "\${aws_ecr_repository.app.repository_url}:latest"
      essential = true
      
      portMappings = [
        {
          containerPort = 3000
          hostPort      = 3000
          protocol      = "tcp"
        }
      ]
      
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.ecs.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "ecs"
        }
      }
      
      environment = [
        {
          name  = "NODE_ENV"
          value = var.environment
        }
      ]
    }
  ])
}

# IAM Roles
resource "aws_iam_role" "ecs_execution" {
  name = "\${var.project_name}-ecs-execution"
  
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "ecs_task" {
  name = "\${var.project_name}-ecs-task"
  
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })
}

# CloudWatch Log Group
resource "aws_cloudwatch_log_group" "ecs" {
  name              = "/ecs/\${var.project_name}"
  retention_in_days = 14
}

# NOTE: This is a minimal ECS setup. For production, you should add:
# - VPC with public/private subnets
# - Application Load Balancer
# - ECS Service with desired_count
# - Auto-scaling policies
# - Security groups
`;

  await fs.writeFile(path.join(tfDir, 'ecs.tf'), ecsTf);
  filesGenerated.push('ecs.tf');
}

// ─── Vercel Configuration ────────────────────────────────────────────────────

async function generateVercelConfig(
  projectDir: string,
  projectName: string,
  analysis: ProjectAnalysis,
  filesGenerated: string[]
): Promise<void> {
  const vercelConfig: any = {
    version: 2,
    name: projectName,
    builds: [],
    routes: [],
  };

  if (analysis.type === 'static' || analysis.type === 'react' || analysis.type === 'vue') {
    vercelConfig.builds.push({
      src: 'package.json',
      use: '@vercel/static-build',
      config: {
        distDir: analysis.outputDir || 'dist',
      },
    });
    // SPA routing
    vercelConfig.routes.push({
      src: '/(.*)',
      dest: '/index.html',
    });
  } else if (analysis.type === 'nextjs') {
    // Next.js is auto-detected, minimal config needed
    delete vercelConfig.builds;
    delete vercelConfig.routes;
  } else if (analysis.type === 'node-api') {
    vercelConfig.builds.push({
      src: 'index.js',
      use: '@vercel/node',
    });
    vercelConfig.routes.push({
      src: '/(.*)',
      dest: '/index.js',
    });
  }

  await fs.writeJson(path.join(projectDir, 'vercel.json'), vercelConfig, { spaces: 2 });
  filesGenerated.push('vercel.json');
}

// ─── Netlify Configuration ───────────────────────────────────────────────────

async function generateNetlifyConfig(
  projectDir: string,
  projectName: string,
  analysis: ProjectAnalysis,
  filesGenerated: string[]
): Promise<void> {
  const netlifyToml = `# Netlify configuration for ${projectName}

[build]
  command = "${analysis.buildCommand || 'npm run build'}"
  publish = "${analysis.outputDir || 'dist'}"

# SPA routing - redirect all requests to index.html
[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200

# Headers for security and caching
[[headers]]
  for = "/*"
  [headers.values]
    X-Frame-Options = "DENY"
    X-XSS-Protection = "1; mode=block"
    X-Content-Type-Options = "nosniff"
    Referrer-Policy = "strict-origin-when-cross-origin"

[[headers]]
  for = "/assets/*"
  [headers.values]
    Cache-Control = "public, max-age=31536000, immutable"

# Environment variables (set in Netlify dashboard)
# [build.environment]
#   NODE_VERSION = "20"
`;

  await fs.writeFile(path.join(projectDir, 'netlify.toml'), netlifyToml);
  filesGenerated.push('netlify.toml');
}

// ─── Instructions Generation ─────────────────────────────────────────────────

function generateInstructions(
  provider: string,
  type: string,
  tfDir: string,
  projectName: string
): string {
  const relTfDir = path.basename(tfDir);

  if (provider === 'aws') {
    return `
## AWS Deployment Instructions for ${projectName}

### Prerequisites
1. Install Terraform: https://www.terraform.io/downloads
2. Install AWS CLI: https://aws.amazon.com/cli/
3. Configure AWS credentials: \`aws configure\`

### Deploy
\`\`\`bash
cd ${relTfDir}

# Initialize Terraform
terraform init

# Review the plan
terraform plan

# Apply (creates resources)
terraform apply

# Get outputs (URLs, IDs)
terraform output
\`\`\`

### Upload Static Files (if applicable)
\`\`\`bash
# Build your project
npm run build

# Sync to S3
aws s3 sync dist/ s3://$(terraform output -raw s3_bucket_name) --delete

# Invalidate CloudFront cache (if using CDN)
aws cloudfront create-invalidation \\
  --distribution-id $(terraform output -raw cloudfront_distribution_id) \\
  --paths "/*"
\`\`\`

### Tear Down
\`\`\`bash
terraform destroy
\`\`\`
`;
  } else if (provider === 'vercel') {
    return `
## Vercel Deployment Instructions for ${projectName}

### Prerequisites
1. Install Vercel CLI: \`npm i -g vercel\`
2. Login to Vercel: \`vercel login\`

### Deploy
\`\`\`bash
# Preview deployment
vercel

# Production deployment
vercel --prod
\`\`\`

### Configuration
The \`vercel.json\` file has been generated with appropriate settings.
You can customize it or configure additional settings in the Vercel dashboard.
`;
  } else {
    return `
## Netlify Deployment Instructions for ${projectName}

### Prerequisites
1. Install Netlify CLI: \`npm i -g netlify-cli\`
2. Login to Netlify: \`netlify login\`

### Deploy
\`\`\`bash
# Link to existing site or create new one
netlify init

# Deploy preview
netlify deploy

# Deploy to production
netlify deploy --prod
\`\`\`

### Configuration
The \`netlify.toml\` file has been generated with appropriate settings.
You can customize build commands, redirects, and headers as needed.
`;
  }
}
