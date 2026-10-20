/**
 * Edge case tests for domain validation
 * Tests for potential false positives with xn-- prefix
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  isValidDomain,
  isValidHostname,
  isValidSubdomain,
  toPunycode,
  isPunycodeDomain,
} from './domain';

describe('Domain Edge Cases - xn-- prefix handling', () => {
  describe('Labels starting with xn-- vs xxx--', () => {
    it('should NOT treat xxx--xxxx as Punycode', () => {
      // xxx--xxxx should be treated as regular ASCII label
      const domain = 'xxx--xxxx.example.com';
      assert.strictEqual(isPunycodeDomain(domain), false);
      assert.strictEqual(isValidDomain(domain), true);
    });

    it('should treat xn--xxxx as Punycode', () => {
      // xn-- prefix IS Punycode
      const domain = 'xn--fsq092h.example.com';
      assert.strictEqual(isPunycodeDomain(domain), true);
      assert.strictEqual(isValidDomain(domain), true);
    });

    it('should distinguish between different -- prefixes', () => {
      // Various prefixes that are NOT Punycode
      assert.strictEqual(isPunycodeDomain('xxx--xxxx.example.com'), false);
      assert.strictEqual(isPunycodeDomain('abc--def.example.com'), false);
      assert.strictEqual(isPunycodeDomain('test--123.example.com'), false);
      
      // These should all be valid as regular domain labels
      assert.strictEqual(isValidDomain('xxx--xxxx.example.com'), true);
      assert.strictEqual(isValidDomain('abc--def.example.com'), true);
      assert.strictEqual(isValidDomain('test--123.example.com'), true);
    });
  });

  describe('isValidHostname with underscore and various prefixes', () => {
    it('should allow xxx--xxxx with underscores in hostname', () => {
      // xxx--xxxx with underscore should be valid for hostname
      assert.strictEqual(isValidHostname('xxx--xxxx_xxx.example.com'), true);
    });

    it('should allow valid xn-- Punycode in hostname', () => {
      // Valid Punycode should work
      assert.strictEqual(isValidHostname('xn--fsq092h.example.com'), true);
    });

    it('should handle mixed underscore and xn-- in hostname', () => {
      // Underscore prefix + valid Punycode
      assert.strictEqual(isValidHostname('_cf.xn--fsq092h.example.com'), true);
    });
  });

  describe('isValidSubdomain with various prefixes', () => {
    it('should allow xxx-- prefix in subdomain', () => {
      assert.strictEqual(isValidSubdomain('xxx--xxxx'), true);
      assert.strictEqual(isValidSubdomain('abc--def'), true);
    });

    it('should validate xn-- prefix in subdomain', () => {
      // Valid Punycode
      assert.strictEqual(isValidSubdomain('xn--fsq092h'), true);
    });
  });

  describe('Mixed scenarios - the main concern', () => {
    it('should handle _cf.xxx--xxxx.xxx correctly (NOT confused with Punycode)', () => {
      // This is the main use case - Cloudflare CNAME targets
      // xxx--xxxx should NOT be treated as Punycode
      const hostname = '_cf.customer.xxx--xxxx.com';
      assert.strictEqual(isPunycodeDomain(hostname), false);
      assert.strictEqual(isValidHostname(hostname), true);
    });

    it('should handle _cf.xn--xxxx.xxx correctly (valid Punycode)', () => {
      // Underscore prefix + valid Punycode
      assert.strictEqual(isValidHostname('_cf.xn--fsq092h.example.com'), true);
    });

    it('should correctly identify real Punycode vs fake', () => {
      // Real Punycode (Chinese domain)
      const chinesePunycode = toPunycode('例子.测试');
      assert.strictEqual(chinesePunycode.includes('xn--'), true);
      assert.strictEqual(isValidDomain(chinesePunycode), true);

      // Fake "Punycode" (xxx-- prefix)
      assert.strictEqual(isPunycodeDomain('xxx--xxxx.com'), false);
    });
  });

  describe('Real-world examples', () => {
    it('should validate Cloudflare _cf records', () => {
      // Common Cloudflare CNAME target pattern
      assert.strictEqual(isValidHostname('_cf.example.com'), true);
      assert.strictEqual(isValidHostname('_cf.customer.xxx--xxxx.com'), true);
    });

    it('should validate DMARC records', () => {
      assert.strictEqual(isValidSubdomain('_dmarc'), true);
      assert.strictEqual(isValidHostname('_dmarc.example.com'), true);
    });

    it('should validate ACME challenge records', () => {
      assert.strictEqual(isValidSubdomain('_acme-challenge'), true);
      assert.strictEqual(isValidSubdomain('_acme-challenge.www'), true);
    });

    it('should handle complex real-world scenarios', () => {
      // Mixed underscore prefix with regular labels containing --
      assert.strictEqual(isValidHostname('_dmarc.xxx--xxxx-yyyy.example.com'), true);
      
      // Multiple levels with --
      assert.strictEqual(isValidSubdomain('xxx--xxxx.yyy--yyyy'), true);
    });

    it('should validate wildcard DNS records', () => {
      // Wildcard as standalone
      assert.strictEqual(isValidHostname('*'), true);
      
      // Wildcard in subdomain (first label)
      assert.strictEqual(isValidHostname('*.example.com'), true);
      assert.strictEqual(isValidHostname('*.sub.example.com'), true);
      
      // Wildcard should only be valid as first label
      assert.strictEqual(isValidHostname('sub.*.example.com'), false);
    });
  });
});
