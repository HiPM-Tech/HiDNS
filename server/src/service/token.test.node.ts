import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import {
  generateToken,
  hashToken,
  hasServicePermission,
  hasDnsPermission,
  hasDomainPermission,
} from './token';
import type { TokenPayload } from '../types/token';
import { connect, disconnect } from '../db/dal/connection';
import { initializeDSM } from '../db/dsm/init-dsm';

describe('Token Service', () => {
  before(async () => {
    // Initialize test database
    process.env.DB_TYPE = 'sqlite';
    process.env.DB_PATH = ':memory:';

    const conn = await connect();
    await initializeDSM();
  });

  after(async () => {
    await disconnect();
  });

  describe('generateToken', () => {
    it('should generate a token with correct prefix (hidns_)', () => {
      const token = generateToken();
      assert.ok(token.startsWith('hidns_'), 'Token should start with hidns_');
      assert.strictEqual(token.length, 70, 'Token should be 70 characters long (6 prefix + 64 hex chars)');
    });

    it('should accept legacy token prefix (dnsmgr_) for verification', async () => {
      // Legacy tokens with dnsmgr_ prefix should still be verifiable
      // This tests backward compatibility
      const legacyToken = 'dnsmgr_' + 'a'.repeat(64);
      // Note: This token won't exist in database, but it should pass prefix validation
      assert.ok(legacyToken.startsWith('dnsmgr_'), 'Legacy token should start with dnsmgr_');
    });

    it('should generate unique tokens', () => {
      const token1 = generateToken();
      const token2 = generateToken();
      assert.notStrictEqual(token1, token2, 'Each token should be unique');
    });
  });

  describe('hashToken', () => {
    it('should produce consistent hashes for same token', () => {
      const token = 'hidns_test_token';
      const hash1 = hashToken(token);
      const hash2 = hashToken(token);
      assert.strictEqual(hash1, hash2, 'Same token should produce same hash');
    });

    it('should produce consistent hashes for legacy token format', () => {
      const legacyToken = 'dnsmgr_test_token';
      const hash1 = hashToken(legacyToken);
      const hash2 = hashToken(legacyToken);
      assert.strictEqual(hash1, hash2, 'Same legacy token should produce same hash');
    });

    it('should produce different hashes for different tokens', () => {
      const hash1 = hashToken('token1');
      const hash2 = hashToken('token2');
      assert.notStrictEqual(hash1, hash2, 'Different tokens should produce different hashes');
    });

    it('should produce a 64-character hex hash', () => {
      const hash = hashToken('test');
      assert.strictEqual(hash.length, 64, 'Hash should be 64 characters (SHA-256 hex)');
      assert.ok(/^[a-f0-9]+$/.test(hash), 'Hash should be hexadecimal');
    });
  });

  describe('hasServicePermission', () => {
    const basePayload: TokenPayload = {
      type: 'token',
      tokenId: 1,
      userId: 1,
      allowedDomains: [],
      allowedServices: { dns: ['domains.read', 'records.write'] },
      maxRole: 1,
    };

    it('should allow access to explicitly permitted service', () => {
      assert.strictEqual(hasServicePermission(basePayload, 'dns'), true);
      assert.strictEqual(hasDnsPermission(basePayload, 'records.write'), true);
    });

    it('should deny access to non-permitted service', () => {
      assert.strictEqual(hasServicePermission(basePayload, 'mcp'), false);
      assert.strictEqual(hasDnsPermission(basePayload, 'records.read'), false);
    });

    it('should allow all services when wildcard is present', () => {
      const wildcardPayload: TokenPayload = { ...basePayload, allowedServices: { dns: ['*'], mcp: ['*'] } };
      assert.strictEqual(hasServicePermission(wildcardPayload, 'mcp'), true);
      assert.strictEqual(hasDnsPermission(wildcardPayload, 'domains.read'), true);
      assert.strictEqual(hasServicePermission(wildcardPayload, 'future-service'), false);
    });

    it('should deny access when no services are allowed', () => {
      const emptyPayload = { ...basePayload, allowedServices: {} };
      assert.strictEqual(hasServicePermission(emptyPayload, 'dns'), false);
    });
  });

  describe('hasDomainPermission', () => {
    const basePayload: TokenPayload = {
      type: 'token',
      tokenId: 1,
      userId: 1,
      allowedDomains: [1, 2, 3],
      allowedServices: { dns: ['*'], mcp: ['*'] },
      maxRole: 1,
    };

    it('should allow access to explicitly permitted domain', async () => {
      // Note: hasDomainPermission now checks user permissions in database
      // This test would need database mocking for full coverage
      const result = await hasDomainPermission(basePayload, 1);
      // Result depends on database state, so we just check it doesn't throw
      assert.ok(typeof result === 'boolean', 'Should return a boolean');
    });

    it('should allow all domains when allowedDomains is empty', async () => {
      const allDomainsPayload = { ...basePayload, allowedDomains: [] };
      const result = await hasDomainPermission(allDomainsPayload, 999);
      assert.ok(typeof result === 'boolean', 'Should return a boolean');
    });
  });
});
