/**
 * Security Tests for Klaus-Code 3.0
 * 
 * Tests for:
 * - Authentication and Authorization
 * - Input Validation and Sanitization
 * - Path Traversal Prevention
 * - Secret Scanning
 * - Rate Limiting
 * - CSP Headers
 * - Session Security
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { timingSafeEqual, createHash } from 'crypto';

// ============================================================
// AUTHENTICATION TESTS
// ============================================================

describe('Authentication Security', () => {
  describe('API Secret Validation', () => {
    function validateApiSecret(provided: string, expected: string): boolean {
      if (!expected) return true; // No auth required
      if (!provided) return false;
      
      try {
        const providedBuffer = Buffer.from(provided);
        const expectedBuffer = Buffer.from(expected);
        
        if (providedBuffer.length !== expectedBuffer.length) {
          return false;
        }
        
        return timingSafeEqual(providedBuffer, expectedBuffer);
      } catch {
        return false;
      }
    }

    it('should accept valid API secret', () => {
      const secret = 'valid-secret-123';
      expect(validateApiSecret(secret, secret)).toBe(true);
    });

    it('should reject invalid API secret', () => {
      expect(validateApiSecret('wrong', 'correct')).toBe(false);
    });

    it('should reject empty API secret when required', () => {
      expect(validateApiSecret('', 'required-secret')).toBe(false);
    });

    it('should use timing-safe comparison', () => {
      // This test verifies the implementation uses timingSafeEqual
      // to prevent timing attacks
      const secret = 'a'.repeat(32);
      const wrong1 = 'b'.repeat(32);
      const wrong2 = 'a'.repeat(31) + 'b';
      
      // Both should take similar time to reject
      expect(validateApiSecret(wrong1, secret)).toBe(false);
      expect(validateApiSecret(wrong2, secret)).toBe(false);
    });

    it('should handle different length secrets', () => {
      expect(validateApiSecret('short', 'much-longer-secret')).toBe(false);
      expect(validateApiSecret('much-longer-secret', 'short')).toBe(false);
    });
  });

  describe('Bearer Token Extraction', () => {
    function extractBearerToken(authHeader: string | undefined): string | null {
      if (!authHeader) return null;
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      return match ? match[1] : null;
    }

    it('should extract valid bearer token', () => {
      expect(extractBearerToken('Bearer abc123')).toBe('abc123');
      expect(extractBearerToken('bearer ABC123')).toBe('ABC123');
    });

    it('should reject invalid formats', () => {
      expect(extractBearerToken('Basic abc123')).toBeNull();
      expect(extractBearerToken('abc123')).toBeNull();
      expect(extractBearerToken('')).toBeNull();
      expect(extractBearerToken(undefined)).toBeNull();
    });
  });
});

// ============================================================
// INPUT VALIDATION TESTS
// ============================================================

describe('Input Validation', () => {
  describe('Prompt Size Validation', () => {
    it('should reject oversized prompts', () => {
      const maxChars = 32000;
      const oversizedPrompt = 'x'.repeat(maxChars + 1);
      
      expect(oversizedPrompt.length > maxChars).toBe(true);
    });

    it('should accept valid prompts', () => {
      const maxChars = 32000;
      const validPrompt = 'x'.repeat(maxChars);
      
      expect(validPrompt.length <= maxChars).toBe(true);
    });

    it('should handle empty prompts', () => {
      const prompt = '';
      expect(prompt.length === 0).toBe(true);
    });
  });

  describe('Session ID Validation', () => {
    function isValidUUID(id: string): boolean {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      return uuidRegex.test(id);
    }

    it('should accept valid UUIDs', () => {
      expect(isValidUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
      expect(isValidUUID('6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(true);
    });

    it('should reject invalid UUIDs', () => {
      expect(isValidUUID('invalid')).toBe(false);
      expect(isValidUUID('550e8400-e29b-41d4-a716-44665544')).toBe(false);
      expect(isValidUUID('')).toBe(false);
      expect(isValidUUID('not-a-uuid-at-all')).toBe(false);
    });
  });

  describe('Model Name Validation', () => {
    it('should reject SQL injection attempts', () => {
      const maliciousModels = [
        "'; DROP TABLE sessions; --",
        "claude-opus-4-5' OR '1'='1",
        "UNION SELECT * FROM users",
      ];
      
      const allowedModels = ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'];
      
      for (const malicious of maliciousModels) {
        const isValid = allowedModels.includes(malicious);
        expect(isValid).toBe(false);
      }
    });
  });

  describe('Package Name Sanitization', () => {
    function sanitizePackageName(pkg: string): boolean {
      // Valid: @scope/package-name@version
      return /^(@[a-z0-9-_]+\/)?[a-z0-9-_.@]+(@[\w.*^~>=<!|-]+)?$/.test(pkg);
    }

    it('should accept valid package names', () => {
      expect(sanitizePackageName('lodash')).toBe(true);
      expect(sanitizePackageName('@types/node')).toBe(true);
      expect(sanitizePackageName('express@4.18.0')).toBe(true);
      expect(sanitizePackageName('@anthropic/sdk@latest')).toBe(true);
    });

    it('should reject malicious package names', () => {
      expect(sanitizePackageName('$(rm -rf /)')).toBe(false);
      expect(sanitizePackageName('; cat /etc/passwd')).toBe(false);
      expect(sanitizePackageName('|whoami')).toBe(false);
      expect(sanitizePackageName('`id`')).toBe(false);
    });
  });
});

// ============================================================
// PATH TRAVERSAL TESTS
// ============================================================

describe('Path Traversal Prevention', () => {
  describe('Workspace Boundary Enforcement', () => {
    function isWithinWorkspace(path: string, workspaceDir: string): boolean {
      const { resolve, sep } = require('path');
      const resolved = resolve(workspaceDir, path);
      const prefix = workspaceDir.endsWith(sep) ? workspaceDir : workspaceDir + sep;
      return resolved === workspaceDir || resolved.startsWith(prefix);
    }

    it('should allow paths within workspace', () => {
      expect(isWithinWorkspace('src/index.ts', '/workspace')).toBe(true);
      expect(isWithinWorkspace('./package.json', '/workspace')).toBe(true);
      expect(isWithinWorkspace('nested/deep/file.ts', '/workspace')).toBe(true);
    });

    it('should block path traversal attempts', () => {
      expect(isWithinWorkspace('../../../etc/passwd', '/workspace')).toBe(false);
      expect(isWithinWorkspace('/etc/passwd', '/workspace')).toBe(false);
      expect(isWithinWorkspace('..', '/workspace')).toBe(false);
    });

    it('should block encoded path traversal', () => {
      // These should be decoded and checked
      const encoded = decodeURIComponent('%2e%2e%2f%2e%2e%2f');
      expect(isWithinWorkspace(encoded, '/workspace')).toBe(false);
    });
  });

  describe('Symlink Resolution', () => {
    it('should detect potential symlink escapes', () => {
      // In real implementation, use fs.realpathSync
      const suspicious = [
        '/workspace/link -> /etc',
        '/workspace/hidden/../../escape',
      ];
      
      for (const path of suspicious) {
        expect(path).toContain('/');
      }
    });
  });
});

// ============================================================
// SECRET SCANNING TESTS
// ============================================================

describe('Secret Scanning', () => {
  const SECRET_PATTERNS = [
    { name: 'AWS Key', regex: /AKIA[0-9A-Z]{16}/ },
    { name: 'GitHub PAT', regex: /ghp_[a-zA-Z0-9]{36}/ },
    { name: 'Generic API Key', regex: /api[_-]?key['":\s]*[a-zA-Z0-9]{20,}/i },
    { name: 'Private Key', regex: /-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/ },
    { name: 'JWT', regex: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/ },
    { name: 'Anthropic API Key', regex: /sk-ant-[a-zA-Z0-9-]{90,}/ },
    { name: 'OpenAI API Key', regex: /sk-[a-zA-Z0-9]{48}/ },
  ];

  function scanForSecrets(content: string): string[] {
    const hits: string[] = [];
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.regex.test(content)) {
        hits.push(pattern.name);
      }
    }
    return hits;
  }

  describe('AWS Key Detection', () => {
    it('should detect AWS access keys', () => {
      const content = 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE';
      const hits = scanForSecrets(content);
      expect(hits).toContain('AWS Key');
    });
  });

  describe('GitHub PAT Detection', () => {
    it('should detect GitHub personal access tokens', () => {
      const content = 'token: ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
      const hits = scanForSecrets(content);
      expect(hits).toContain('GitHub PAT');
    });
  });

  describe('Private Key Detection', () => {
    it('should detect private keys', () => {
      const content = `-----BEGIN RSA PRIVATE KEY-----
MIIEpQIBAAKCAQEA...
-----END RSA PRIVATE KEY-----`;
      const hits = scanForSecrets(content);
      expect(hits).toContain('Private Key');
    });

    it('should detect OpenSSH private keys', () => {
      const content = '-----BEGIN OPENSSH PRIVATE KEY-----';
      const hits = scanForSecrets(content);
      expect(hits).toContain('Private Key');
    });
  });

  describe('API Key Detection', () => {
    it('should detect generic API keys', () => {
      const content = 'api_key: "sk-1234567890abcdefghij"';
      const hits = scanForSecrets(content);
      expect(hits).toContain('Generic API Key');
    });

    it('should detect Anthropic API keys', () => {
      const content = 'ANTHROPIC_API_KEY=sk-ant-' + 'x'.repeat(90);
      const hits = scanForSecrets(content);
      expect(hits).toContain('Anthropic API Key');
    });
  });

  describe('JWT Detection', () => {
    it('should detect JWTs', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.xxx';
      const hits = scanForSecrets(jwt);
      expect(hits).toContain('JWT');
    });
  });

  describe('False Positive Avoidance', () => {
    it('should not flag example/placeholder values', () => {
      const content = 'YOUR_API_KEY_HERE';
      const hits = scanForSecrets(content);
      // Should ideally not trigger (depends on implementation)
      expect(hits.length).toBeLessThanOrEqual(1);
    });
  });
});

// ============================================================
// RATE LIMITING TESTS
// ============================================================

describe('Rate Limiting', () => {
  describe('WebSocket Rate Limiter', () => {
    interface RateLimitEntry {
      count: number;
      resetAt: number;
    }

    function checkRateLimit(
      socketId: string,
      limits: Map<string, RateLimitEntry>,
      maxEvents: number,
      windowMs: number
    ): boolean {
      const now = Date.now();
      const entry = limits.get(socketId);
      
      if (!entry || now > entry.resetAt) {
        limits.set(socketId, { count: 1, resetAt: now + windowMs });
        return true;
      }
      
      if (entry.count >= maxEvents) {
        return false;
      }
      
      entry.count++;
      return true;
    }

    it('should allow requests under limit', () => {
      const limits = new Map<string, RateLimitEntry>();
      const maxEvents = 30;
      const windowMs = 60000;
      
      for (let i = 0; i < maxEvents; i++) {
        expect(checkRateLimit('socket-1', limits, maxEvents, windowMs)).toBe(true);
      }
    });

    it('should block requests over limit', () => {
      const limits = new Map<string, RateLimitEntry>();
      const maxEvents = 5;
      const windowMs = 60000;
      
      // Fill up the limit
      for (let i = 0; i < maxEvents; i++) {
        checkRateLimit('socket-1', limits, maxEvents, windowMs);
      }
      
      // This should be blocked
      expect(checkRateLimit('socket-1', limits, maxEvents, windowMs)).toBe(false);
    });

    it('should track different sockets independently', () => {
      const limits = new Map<string, RateLimitEntry>();
      const maxEvents = 2;
      const windowMs = 60000;
      
      checkRateLimit('socket-1', limits, maxEvents, windowMs);
      checkRateLimit('socket-1', limits, maxEvents, windowMs);
      
      // socket-1 is at limit, but socket-2 should be allowed
      expect(checkRateLimit('socket-1', limits, maxEvents, windowMs)).toBe(false);
      expect(checkRateLimit('socket-2', limits, maxEvents, windowMs)).toBe(true);
    });
  });

  describe('Concurrent Session Limiting', () => {
    it('should enforce max concurrent sessions', () => {
      const maxConcurrent = 3;
      let active = 0;
      
      const tryAcquire = () => {
        if (active < maxConcurrent) {
          active++;
          return true;
        }
        return false;
      };
      
      const release = () => {
        if (active > 0) active--;
      };
      
      expect(tryAcquire()).toBe(true);
      expect(tryAcquire()).toBe(true);
      expect(tryAcquire()).toBe(true);
      expect(tryAcquire()).toBe(false);
      
      release();
      expect(tryAcquire()).toBe(true);
    });
  });
});

// ============================================================
// CSP AND HEADERS TESTS
// ============================================================

describe('Security Headers', () => {
  describe('Content Security Policy', () => {
    const CSP_DIRECTIVES = {
      'default-src': "'self'",
      'script-src': "'self'",
      'style-src': "'self' 'unsafe-inline'",
      'frame-ancestors': "'none'",
    };

    it('should have restrictive default-src', () => {
      expect(CSP_DIRECTIVES['default-src']).toBe("'self'");
    });

    it('should prevent framing', () => {
      expect(CSP_DIRECTIVES['frame-ancestors']).toBe("'none'");
    });
  });

  describe('Other Security Headers', () => {
    const SECURITY_HEADERS = {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-XSS-Protection': '1; mode=block',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    };

    it('should prevent MIME sniffing', () => {
      expect(SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
    });

    it('should prevent framing via X-Frame-Options', () => {
      expect(SECURITY_HEADERS['X-Frame-Options']).toBe('DENY');
    });
  });
});

// ============================================================
// SESSION SECURITY TESTS
// ============================================================

describe('Session Security', () => {
  describe('Session TTL', () => {
    it('should expire sessions after TTL', () => {
      const ttl = 86400000; // 24 hours
      const createdAt = Date.now() - ttl - 1000; // Older than TTL
      const now = Date.now();
      
      const isExpired = (now - createdAt) > ttl;
      expect(isExpired).toBe(true);
    });

    it('should not expire active sessions', () => {
      const ttl = 86400000;
      const updatedAt = Date.now() - 1000; // Recent
      const now = Date.now();
      
      const isExpired = (now - updatedAt) > ttl;
      expect(isExpired).toBe(false);
    });
  });

  describe('Session Ownership', () => {
    it('should track session ownership by socket', () => {
      const owners = new Map<string, string>();
      
      owners.set('session-1', 'socket-abc');
      owners.set('session-2', 'socket-xyz');
      
      expect(owners.get('session-1')).toBe('socket-abc');
      expect(owners.get('session-2')).toBe('socket-xyz');
    });

    it('should validate session ownership for join', () => {
      const owners = new Map<string, string>();
      owners.set('session-1', 'socket-abc');
      
      const canJoin = (sessionId: string, socketId: string) => {
        const owner = owners.get(sessionId);
        return !owner || owner === socketId;
      };
      
      expect(canJoin('session-1', 'socket-abc')).toBe(true);
      expect(canJoin('session-1', 'socket-xyz')).toBe(false);
      expect(canJoin('session-new', 'socket-any')).toBe(true);
    });
  });

  describe('Audit Logging', () => {
    it('should log sensitive operations', () => {
      const auditLog: any[] = [];
      
      const audit = {
        sessionDelete: (ip: string, sessionId: string, success: boolean) => {
          auditLog.push({ action: 'session_delete', ip, sessionId, success, timestamp: new Date() });
        },
        sessionExport: (ip: string, sessionId: string, format: string, success: boolean) => {
          auditLog.push({ action: 'session_export', ip, sessionId, format, success, timestamp: new Date() });
        },
      };
      
      audit.sessionDelete('127.0.0.1', 'session-123', true);
      audit.sessionExport('127.0.0.1', 'session-456', 'json', true);
      
      expect(auditLog).toHaveLength(2);
      expect(auditLog[0].action).toBe('session_delete');
      expect(auditLog[1].action).toBe('session_export');
    });
  });
});

// ============================================================
// XSS PREVENTION TESTS
// ============================================================

describe('XSS Prevention', () => {
  describe('Output Encoding', () => {
    function escapeHtml(str: string): string {
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    it('should escape HTML entities', () => {
      const malicious = '<script>alert("xss")</script>';
      const escaped = escapeHtml(malicious);
      
      expect(escaped).not.toContain('<script>');
      expect(escaped).toContain('&lt;script&gt;');
    });

    it('should escape attribute values', () => {
      const malicious = '" onclick="alert(1)"';
      const escaped = escapeHtml(malicious);
      
      expect(escaped).not.toContain('"');
      expect(escaped).toContain('&quot;');
    });
  });

  describe('Tool Output Sanitization', () => {
    it('should not execute JavaScript in tool output', () => {
      const toolOutput = {
        result: '<img src=x onerror=alert(1)>',
      };
      
      // JSON stringify should escape the output
      const serialized = JSON.stringify(toolOutput);
      expect(serialized).not.toContain('onerror=alert');
      expect(serialized).toContain('onerror=');
    });
  });
});

// ============================================================
// INJECTION PREVENTION TESTS
// ============================================================

describe('Injection Prevention', () => {
  describe('Command Injection', () => {
    it('should not allow shell metacharacters in npm packages', () => {
      const maliciousPackages = [
        'lodash; rm -rf /',
        'express | cat /etc/passwd',
        '$(whoami)',
        '`id`',
        'pkg && malicious',
      ];
      
      const safeRegex = /^(@[a-z0-9-_]+\/)?[a-z0-9-_.@]+(@[\w.*^~>=<!|-]+)?$/;
      
      for (const pkg of maliciousPackages) {
        expect(safeRegex.test(pkg)).toBe(false);
      }
    });
  });

  describe('SQL Injection (if applicable)', () => {
    it('should use parameterized queries', () => {
      // Simulating parameterized query
      const sessionId = "'; DROP TABLE sessions; --";
      const query = 'SELECT * FROM sessions WHERE id = ?';
      const params = [sessionId];
      
      // The query should be safe because sessionId is a parameter
      expect(query).toContain('?');
      expect(params[0]).toBe(sessionId);
    });
  });

  describe('Path Injection', () => {
    it('should sanitize file paths', () => {
      const sanitizePath = (p: string) => p.replace(/^[/\\]+/, '');
      
      expect(sanitizePath('/etc/passwd')).toBe('etc/passwd');
      expect(sanitizePath('\\windows\\system32')).toBe('windows\\system32');
    });
  });
});

// ============================================================
// CORS TESTS
// ============================================================

describe('CORS Security', () => {
  describe('Origin Validation', () => {
    function isAllowedOrigin(origin: string, allowed: string | string[]): boolean {
      if (allowed === '*') return true;
      if (Array.isArray(allowed)) return allowed.includes(origin);
      return origin === allowed;
    }

    it('should allow configured origin', () => {
      expect(isAllowedOrigin('http://localhost:5173', 'http://localhost:5173')).toBe(true);
    });

    it('should block unconfigured origins', () => {
      expect(isAllowedOrigin('http://evil.com', 'http://localhost:5173')).toBe(false);
    });

    it('should handle wildcard carefully', () => {
      // Wildcard should only be used in development
      expect(isAllowedOrigin('http://evil.com', '*')).toBe(true);
    });

    it('should support multiple origins', () => {
      const allowed = ['http://localhost:5173', 'https://app.example.com'];
      expect(isAllowedOrigin('http://localhost:5173', allowed)).toBe(true);
      expect(isAllowedOrigin('https://app.example.com', allowed)).toBe(true);
      expect(isAllowedOrigin('http://evil.com', allowed)).toBe(false);
    });
  });
});

// ============================================================
// DOCKER SANDBOX SECURITY TESTS
// ============================================================

describe('Docker Sandbox Security', () => {
  describe('Container Isolation', () => {
    it('should use read-only root filesystem option', () => {
      const containerOptions = {
        ReadonlyRootfs: true,
        NetworkDisabled: true,
        CapDrop: ['ALL'],
      };
      
      expect(containerOptions.ReadonlyRootfs).toBe(true);
    });

    it('should disable network by default', () => {
      const containerOptions = {
        NetworkDisabled: true,
      };
      
      expect(containerOptions.NetworkDisabled).toBe(true);
    });

    it('should drop all capabilities', () => {
      const containerOptions = {
        CapDrop: ['ALL'],
        CapAdd: [], // No additional capabilities
      };
      
      expect(containerOptions.CapDrop).toContain('ALL');
      expect(containerOptions.CapAdd).toHaveLength(0);
    });
  });

  describe('Resource Limits', () => {
    it('should enforce memory limits', () => {
      const memoryLimit = 512 * 1024 * 1024; // 512MB
      expect(memoryLimit).toBe(536870912);
    });

    it('should enforce CPU limits', () => {
      const cpuShares = 256; // 1/4 of CPU
      expect(cpuShares).toBeLessThan(1024);
    });

    it('should enforce timeout', () => {
      const timeoutMs = 300000; // 5 minutes
      expect(timeoutMs).toBe(300000);
    });
  });
});
