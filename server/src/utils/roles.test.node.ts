import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  ROLE_USER,
  ROLE_ADMIN,
  ROLE_SUPER,
  isAdmin,
  isSuper,
  normalizeRole,
} from './roles';

describe('Roles Utils', () => {
  describe('Role Constants', () => {
    it('should have correct role values', () => {
      assert.strictEqual(ROLE_USER, 1, 'ROLE_USER should be 1');
      assert.strictEqual(ROLE_ADMIN, 2, 'ROLE_ADMIN should be 2');
      assert.strictEqual(ROLE_SUPER, 3, 'ROLE_SUPER should be 3');
    });
  });

  describe('isAdmin', () => {
    it('should return true for admin role', () => {
      assert.strictEqual(isAdmin(ROLE_ADMIN), true);
      assert.strictEqual(isAdmin(ROLE_SUPER), true);
    });

    it('should return false for non-admin roles', () => {
      assert.strictEqual(isAdmin(ROLE_USER), false);
      assert.strictEqual(isAdmin(0), false);
      assert.strictEqual(isAdmin(4), false);
    });

    it('should handle edge cases', () => {
      assert.strictEqual(isAdmin(-1), false);
      assert.strictEqual(isAdmin(undefined as any), false);
      assert.strictEqual(isAdmin(null as any), false);
    });
  });

  describe('isSuper', () => {
    it('should return true for super admin role', () => {
      assert.strictEqual(isSuper(ROLE_SUPER), true);
    });

    it('should return false for non-super roles', () => {
      assert.strictEqual(isSuper(ROLE_ADMIN), false);
      assert.strictEqual(isSuper(ROLE_USER), false);
      assert.strictEqual(isSuper(0), false);
    });

    it('should handle edge cases', () => {
      assert.strictEqual(isSuper(-1), false);
      assert.strictEqual(isSuper(undefined as any), false);
      assert.strictEqual(isSuper(null as any), false);
    });
  });

  describe('normalizeRole', () => {
    it('should return valid roles as-is', () => {
      assert.strictEqual(normalizeRole(ROLE_USER), ROLE_USER);
      assert.strictEqual(normalizeRole(ROLE_ADMIN), ROLE_ADMIN);
      assert.strictEqual(normalizeRole(ROLE_SUPER), ROLE_SUPER);
    });

    it('should default invalid roles to ROLE_USER', () => {
      assert.strictEqual(normalizeRole(0), ROLE_USER);
      assert.strictEqual(normalizeRole(4), ROLE_USER);
      assert.strictEqual(normalizeRole(-1), ROLE_USER);
      assert.strictEqual(normalizeRole(99), ROLE_USER);
    });

    it('should handle edge cases', () => {
      assert.strictEqual(normalizeRole(undefined as any), ROLE_USER);
      assert.strictEqual(normalizeRole(null as any), ROLE_USER);
      assert.strictEqual(normalizeRole('admin' as any), ROLE_ADMIN); // 'admin' string is mapped to ROLE_ADMIN
    });
  });
});
