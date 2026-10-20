/**
 * Domain utilities tests - IDN (Internationalized Domain Name) support
 * Tests Chinese, Japanese, Emoji and other Unicode domain names
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  toPunycode,
  toUnicode,
  isUnicodeDomain,
  isPunycodeDomain,
  normalizeDomain,
  isValidDomain,
  isValidSubdomain,
  getDisplayDomain,
  areDomainsEqual,
} from './domain';

describe('Domain Utilities - IDN Support', () => {
  describe('Chinese Domains', () => {
    it('should convert Chinese domain to Punycode', () => {
      // Note: Actual Punycode values depend on Unicode normalization
      const punycode = toPunycode('例子.测试');
      assert.strictEqual(punycode.includes('xn--'), true);
      assert.strictEqual(punycode.endsWith('.xn--0zwm56d'), true);
    });

    it('should convert Punycode to Chinese', () => {
      // First convert to Punycode, then back to Unicode
      const punycode = toPunycode('例子.测试');
      const unicode = toUnicode(punycode);
      // The round-trip should preserve the domain
      assert.strictEqual(areDomainsEqual('例子.测试', unicode), true);
    });

    it('should validate Chinese domains', () => {
      assert.strictEqual(isValidDomain('例子.测试'), true);
      assert.strictEqual(isValidDomain('中文.中国'), true);
    });
  });

  describe('Japanese Domains', () => {
    it('should convert Japanese domain to Punycode', () => {
      // Japanese domain: 例え.jp
      const punycode1 = toPunycode('例え.jp');
      assert.strictEqual(punycode1.includes('xn--'), true);
      assert.strictEqual(punycode1.endsWith('.jp'), true);
      
      // Japanese domain: テスト.jp
      const punycode2 = toPunycode('テスト.jp');
      assert.strictEqual(punycode2.includes('xn--'), true);
    });

    it('should convert Punycode to Japanese', () => {
      const punycode = toPunycode('例え.jp');
      const unicode = toUnicode(punycode);
      assert.strictEqual(areDomainsEqual('例え.jp', unicode), true);
    });

    it('should validate Japanese domains', () => {
      assert.strictEqual(isValidDomain('例え.jp'), true);
      assert.strictEqual(isValidDomain('テスト.jp'), true);
      assert.strictEqual(isValidDomain('www.日本語.jp'), true);
    });
  });

  describe('Emoji Domains', () => {
    it('should convert emoji domain to Punycode', () => {
      // Emoji domain: 😀.com
      const punycode1 = toPunycode('😀.com');
      assert.strictEqual(punycode1.includes('xn--'), true);
      assert.strictEqual(punycode1.endsWith('.com'), true);
      
      // Emoji domain: 🚀.ws
      const punycode2 = toPunycode('🚀.ws');
      assert.strictEqual(punycode2.includes('xn--'), true);
      
      // Multiple emojis: 👍👎.com
      const punycode3 = toPunycode('👍👎.com');
      assert.strictEqual(punycode3.includes('xn--'), true);
    });

    it('should convert Punycode to emoji', () => {
      const punycode = toPunycode('😀.com');
      const unicode = toUnicode(punycode);
      assert.strictEqual(areDomainsEqual('😀.com', unicode), true);
    });

    it('should validate emoji domains', () => {
      assert.strictEqual(isValidDomain('😀.com'), true);
      assert.strictEqual(isValidDomain('🚀.ws'), true);
      assert.strictEqual(isValidDomain('👍👎.com'), true);
    });
  });

  describe('Korean Domains', () => {
    it('should convert Korean domain to Punycode', () => {
      // Korean domain: 한국.kr
      const punycode1 = toPunycode('한국.kr');
      assert.strictEqual(punycode1.includes('xn--'), true);
      
      // Korean domain: 테스트.kr
      const punycode2 = toPunycode('테스트.kr');
      assert.strictEqual(punycode2.includes('xn--'), true);
    });

    it('should validate Korean domains', () => {
      assert.strictEqual(isValidDomain('한국.kr'), true);
      assert.strictEqual(isValidDomain('테스트.kr'), true);
    });
  });

  describe('Arabic Domains', () => {
    it('should convert Arabic domain to Punycode', () => {
      // Arabic domain should contain xn--
      const punycode = toPunycode('مثال.مصر');
      assert.strictEqual(punycode.includes('xn--'), true);
    });

    it('should validate Arabic domains', () => {
      assert.strictEqual(isValidDomain('مثال.مصر'), true);
    });
  });

  describe('Cyrillic Domains', () => {
    it('should convert Cyrillic domain to Punycode', () => {
      // Russian domain: пример.рф
      const punycode = toPunycode('пример.рф');
      assert.strictEqual(punycode.includes('xn--'), true);
    });

    it('should validate Cyrillic domains', () => {
      assert.strictEqual(isValidDomain('пример.рф'), true);
    });
  });

  describe('normalizeDomain', () => {
    it('should normalize various IDN domains', () => {
      // Chinese - should convert to Punycode
      const normalized1 = normalizeDomain('例子.测试');
      assert.strictEqual(normalized1.includes('xn--'), true);
      
      // Japanese
      const normalized2 = normalizeDomain('例え.jp');
      assert.strictEqual(normalized2.includes('xn--'), true);
      
      // Emoji
      const normalized3 = normalizeDomain('😀.com');
      assert.strictEqual(normalized3.includes('xn--'), true);
      
      // ASCII should remain unchanged
      assert.strictEqual(normalizeDomain('example.com'), 'example.com');
    });
  });

  describe('areDomainsEqual', () => {
    it('should consider Unicode and Punycode as equal', () => {
      // Chinese
      assert.strictEqual(areDomainsEqual('例子.测试', toPunycode('例子.测试')), true);
      // Japanese
      assert.strictEqual(areDomainsEqual('例え.jp', toPunycode('例え.jp')), true);
      // Emoji
      assert.strictEqual(areDomainsEqual('😀.com', toPunycode('😀.com')), true);
    });
  });

  describe('Subdomain support', () => {
    it('should support IDN subdomains', () => {
      // Chinese subdomain
      assert.strictEqual(isValidSubdomain('子域名'), true);
      // Japanese subdomain
      assert.strictEqual(isValidSubdomain('サブドメイン'), true);
      // Emoji subdomain
      assert.strictEqual(isValidSubdomain('🎉'), true);
    });
  });

  describe('Mixed domains', () => {
    it('should handle mixed ASCII and Unicode', () => {
      // www.例子.com
      const punycode = toPunycode('www.例子.com');
      assert.strictEqual(punycode.startsWith('www.'), true);
      assert.strictEqual(punycode.endsWith('.com'), true);
      assert.strictEqual(punycode.includes('xn--'), true);
      
      // mail.日本語.jp
      const punycode2 = toPunycode('mail.日本語.jp');
      assert.strictEqual(punycode2.startsWith('mail.'), true);
      assert.strictEqual(punycode2.includes('xn--'), true);
    });
  });

  describe('Utility functions', () => {
    it('should detect Unicode domains', () => {
      assert.strictEqual(isUnicodeDomain('例子.测试'), true);
      assert.strictEqual(isUnicodeDomain('example.com'), false);
      assert.strictEqual(isUnicodeDomain('xn--fsq092h.xn--0zwm56d'), false);
    });

    it('should detect Punycode domains', () => {
      assert.strictEqual(isPunycodeDomain('xn--fsq092h.xn--0zwm56d'), true);
      assert.strictEqual(isPunycodeDomain('example.com'), false);
      assert.strictEqual(isPunycodeDomain('例子.测试'), false);
    });
  });
});
