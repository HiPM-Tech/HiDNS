import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import {
  UserOperations,
  DnsAccountOperations,
  DomainOperations,
  TeamOperations,
  DomainPermissionOperations,
  TokenOperations,
  SecretOperations,
  SettingsOperations,
} from './business-adapter';
import { connect, disconnect, getConnection } from '../dal/connection';
import { initializeDSM } from '../dsm/init-dsm';

// Test database configuration
const TEST_DB_PATH = ':memory:';

describe('Business Adapter Layer', () => {
  before(async () => {
    // Initialize test database
    process.env.DB_TYPE = 'sqlite';
    process.env.DB_PATH = TEST_DB_PATH;

    const conn = await connect();
    await initializeDSM();
  });

  after(async () => {
    await disconnect();
  });

  describe('UserOperations', () => {
    let testUserId: number;

    it('should create a new user', async () => {
      const id = await UserOperations.create({
        username: 'testuser',
        nickname: 'Test User',
        email: 'test@example.com',
        password_hash: 'hashed_password',
        role: 'member',
        role_level: 1,
      });
      
      assert.ok(id > 0, 'User ID should be greater than 0');
      testUserId = id;
    });

    it('should get user by ID', async () => {
      const user = await UserOperations.getById(testUserId);
      
      assert.ok(user, 'User should exist');
      assert.strictEqual(user?.username, 'testuser');
      assert.strictEqual(user?.nickname, 'Test User');
      assert.strictEqual(user?.email, 'test@example.com');
      assert.strictEqual(user?.role, 1);
      assert.strictEqual(user?.role_name, 'member');
    });

    it('should get user by username', async () => {
      const user = await UserOperations.getByUsername('testuser');
      
      assert.ok(user, 'User should exist');
      assert.strictEqual(user?.id, testUserId);
    });

    it('should get all users', async () => {
      const users = await UserOperations.getAll();
      
      assert.ok(Array.isArray(users), 'Should return an array');
      assert.ok(users.length >= 1, 'Should have at least one user');
    });

    it('should update user', async () => {
      await UserOperations.update(testUserId, {
        nickname: 'Updated Name',
        email: 'updated@example.com',
      });
      
      const user = await UserOperations.getById(testUserId);
      assert.strictEqual(user?.nickname, 'Updated Name');
      assert.strictEqual(user?.email, 'updated@example.com');
    });

    it('should update user password', async () => {
      await UserOperations.updatePassword(testUserId, 'new_hashed_password');
      
      const user = await UserOperations.getById(testUserId);
      // Password is not returned in getById for security
      assert.ok(user, 'User should still exist');
    });

    it('should get user count', async () => {
      const count = await UserOperations.getCount();
      
      assert.ok(count >= 1, 'Should have at least one user');
    });

    it('should delete user', async () => {
      // Create a user to delete
      const id = await UserOperations.create({
        username: 'deletetest',
        nickname: 'Delete Test',
        email: 'delete@example.com',
        password_hash: 'hashed',
        role: 'member',
        role_level: 1,
      });
      
      await UserOperations.delete(id);
      
      const user = await UserOperations.getById(id);
      assert.strictEqual(user, undefined, 'User should be deleted');
    });
  });

  describe('DnsAccountOperations', () => {
    let testAccountId: number;
    const testUserId = 1;

    it('should create a DNS account', async () => {
      const id = await DnsAccountOperations.create({
        type: 'cloudflare',
        name: 'Test CF Account',
        config: JSON.stringify({ token: 'test_token', accountId: 'test_account' }),
        remark: 'Test remark',
        created_by: testUserId,
      });
      
      assert.ok(id > 0, 'Account ID should be greater than 0');
      testAccountId = id;
    });

    it('should get account by ID', async () => {
      const account = await DnsAccountOperations.getById(testAccountId);
      
      assert.ok(account, 'Account should exist');
      assert.strictEqual(account?.type, 'cloudflare');
      assert.strictEqual(account?.name, 'Test CF Account');
    });

    it('should get all accounts', async () => {
      const accounts = await DnsAccountOperations.getAll();
      
      assert.ok(Array.isArray(accounts), 'Should return an array');
      assert.ok(accounts.length >= 1, 'Should have at least one account');
    });

    it('should get accounts by user ID', async () => {
      const accounts = await DnsAccountOperations.getByUserId(testUserId);
      
      assert.ok(Array.isArray(accounts), 'Should return an array');
      assert.ok(accounts.length >= 1, 'Should have at least one account for user');
    });

    it('should get accounts by type', async () => {
      const accounts = await DnsAccountOperations.getByType('cloudflare');
      
      assert.ok(Array.isArray(accounts), 'Should return an array');
      assert.ok(accounts.every(a => a.type === 'cloudflare'), 'All accounts should be cloudflare type');
    });

    it('should update account', async () => {
      await DnsAccountOperations.update(testAccountId, {
        name: 'Updated CF Account',
        remark: 'Updated remark',
      });
      
      const account = await DnsAccountOperations.getById(testAccountId);
      assert.strictEqual(account?.name, 'Updated CF Account');
    });

    it('should get account creator', async () => {
      const createdBy = await DnsAccountOperations.getCreatedBy(testAccountId);
      
      assert.strictEqual(createdBy, testUserId);
    });

    it('should delete account', async () => {
      const id = await DnsAccountOperations.create({
        type: 'aliyun',
        name: 'Delete Test Account',
        config: '{}',
        remark: '',
        created_by: testUserId,
      });
      
      await DnsAccountOperations.delete(id);
      
      const account = await DnsAccountOperations.getById(id);
      assert.strictEqual(account, undefined, 'Account should be deleted');
    });
  });

  describe('DomainOperations', () => {
    let testDomainId: number;
    let testAccountId: number;

    before(async () => {
      // Create a test account for domains
      testAccountId = await DnsAccountOperations.create({
        type: 'cloudflare',
        name: 'Domain Test Account',
        config: '{}',
        remark: '',
        created_by: 1,
      });
    });

    it('should create a domain', async () => {
      const id = await DomainOperations.create({
        account_id: testAccountId,
        name: 'test.example.com',
        third_id: 'cf_domain_123',
        record_count: 5,
      });
      
      assert.ok(id > 0, 'Domain ID should be greater than 0');
      testDomainId = id;
    });

    it('should get domain by ID', async () => {
      const domain = await DomainOperations.getById(testDomainId);
      
      assert.ok(domain, 'Domain should exist');
      assert.strictEqual(domain?.name, 'test.example.com');
      assert.strictEqual(domain?.third_id, 'cf_domain_123');
    });

    it('should get domain by account ID and name', async () => {
      const domain = await DomainOperations.getByAccountIdAndName(testAccountId, 'test.example.com');
      
      assert.ok(domain, 'Domain should exist');
      assert.strictEqual(domain?.id, testDomainId);
    });

    it('should get domains by account ID', async () => {
      const domains = await DomainOperations.getByAccountId(testAccountId);
      
      assert.ok(Array.isArray(domains), 'Should return an array');
      assert.ok(domains.length >= 1, 'Should have at least one domain');
    });

    it('should update record count', async () => {
      await DomainOperations.updateRecordCount(testDomainId, 10);
      
      const domain = await DomainOperations.getById(testDomainId);
      assert.strictEqual(domain?.record_count, 10);
    });

    it('should update third ID and record count', async () => {
      await DomainOperations.updateThirdIdAndRecordCount(testDomainId, 'updated_cf_id', 15);
      
      const domain = await DomainOperations.getById(testDomainId);
      assert.strictEqual(domain?.third_id, 'updated_cf_id');
      assert.strictEqual(domain?.record_count, 15);
    });

    it('should update remark and hidden status', async () => {
      await DomainOperations.updateRemarkAndHidden(testDomainId, 'Test remark', 1);
      
      const domain = await DomainOperations.getById(testDomainId);
      assert.strictEqual(domain?.remark, 'Test remark');
      assert.strictEqual(domain?.is_hidden, 1);
    });

    it('should delete domain', async () => {
      const id = await DomainOperations.create({
        account_id: testAccountId,
        name: 'delete.test.com',
        third_id: '',
        record_count: 0,
      });
      
      await DomainOperations.delete(id);
      
      const domain = await DomainOperations.getById(id);
      assert.strictEqual(domain, undefined, 'Domain should be deleted');
    });
  });

  describe('TeamOperations', () => {
    let testTeamId: number;
    let testUserId: number;

    before(async () => {
      // Create a test user for team tests
      testUserId = await UserOperations.create({
        username: 'teamtestuser',
        nickname: 'Team Test User',
        email: 'teamtest@example.com',
        password_hash: 'hashed',
        role: 'member',
        role_level: 1,
      });
    });

    it('should create a team', async () => {
      const id = await TeamOperations.create({
        name: 'Test Team',
        description: 'A test team',
        created_by: testUserId,
      });
      
      assert.ok(id > 0, 'Team ID should be greater than 0');
      testTeamId = id;
      await TeamOperations.addMember(testTeamId, testUserId, 'admin');
    });

    it('should get team by ID', async () => {
      const team = await TeamOperations.getById(testTeamId);
      
      assert.ok(team, 'Team should exist');
      assert.strictEqual(team?.name, 'Test Team');
    });

    it('should get all teams', async () => {
      const teams = await TeamOperations.getAll();
      
      assert.ok(Array.isArray(teams), 'Should return an array');
      assert.ok(teams.length >= 1, 'Should have at least one team');
    });

    it('should get teams by user ID', async () => {
      const teams = await TeamOperations.getByUserId(testUserId);
      
      assert.ok(Array.isArray(teams), 'Should return an array');
    });

    it('should add member to team', async () => {
      // Create another user to add as member
      const memberId = await UserOperations.create({
        username: 'teammember',
        nickname: 'Team Member',
        email: 'member@example.com',
        password_hash: 'hashed',
        role: 'member',
        role_level: 1,
      });
      
      await TeamOperations.addMember(testTeamId, memberId, 'member');
      
      const isMember = await TeamOperations.isMember(testTeamId, memberId);
      assert.strictEqual(isMember, true, 'User should be a member');
    });

    it('should get team members', async () => {
      const members = await TeamOperations.getMembers(testTeamId);
      
      assert.ok(Array.isArray(members), 'Should return an array');
      assert.ok(members.length >= 1, 'Should have at least one member');
    });

    it('should get member with role', async () => {
      const member = await TeamOperations.getMemberWithRole(testTeamId, testUserId);
      
      assert.ok(member, 'Member should exist');
      assert.ok(member?.role, 'Member should have a role');
    });

    it('should update member role', async () => {
      // Create a member to update
      const memberId = await UserOperations.create({
        username: 'roletest',
        nickname: 'Role Test',
        email: 'role@example.com',
        password_hash: 'hashed',
        role: 'member',
        role_level: 1,
      });
      
      await TeamOperations.addMember(testTeamId, memberId, 'member');
      await TeamOperations.updateMemberRole(testTeamId, memberId, 'admin');
      
      const member = await TeamOperations.getMemberWithRole(testTeamId, memberId);
      assert.strictEqual(member?.role, 'admin');
    });

    it('should get team IDs by user ID', async () => {
      const teamIds = await TeamOperations.getTeamIdsByUserId(testUserId);
      
      assert.ok(Array.isArray(teamIds), 'Should return an array');
      assert.ok(teamIds.includes(testTeamId), 'Should include the test team');
    });

    it('should update team', async () => {
      await TeamOperations.update(testTeamId, {
        name: 'Updated Team Name',
        description: 'Updated description',
      });
      
      const team = await TeamOperations.getById(testTeamId);
      assert.strictEqual(team?.name, 'Updated Team Name');
    });

    it('should remove member from team', async () => {
      const memberId = await UserOperations.create({
        username: 'removemember',
        nickname: 'Remove Member',
        email: 'remove@example.com',
        password_hash: 'hashed',
        role: 'member',
        role_level: 1,
      });
      
      await TeamOperations.addMember(testTeamId, memberId, 'member');
      await TeamOperations.removeMember(testTeamId, memberId);
      
      const isMember = await TeamOperations.isMember(testTeamId, memberId);
      assert.strictEqual(isMember, false, 'User should not be a member');
    });

    it('should delete team', async () => {
      const id = await TeamOperations.create({
        name: 'Delete Test Team',
        description: '',
        created_by: testUserId,
      });
      
      await TeamOperations.delete(id);
      
      const team = await TeamOperations.getById(id);
      assert.strictEqual(team, undefined, 'Team should be deleted');
    });
  });

  describe('DomainPermissionOperations', () => {
    let testPermissionId: number;
    let testDomainId: number;
    let testUserId: number;
    let testTeamId: number;

    before(async () => {
      // Create test data
      testUserId = await UserOperations.create({
        username: 'permtestuser',
        nickname: 'Perm Test User',
        email: 'permtest@example.com',
        password_hash: 'hashed',
        role: 'member',
        role_level: 1,
      });

      const accountId = await DnsAccountOperations.create({
        type: 'cloudflare',
        name: 'Perm Test Account',
        config: '{}',
        remark: '',
        created_by: testUserId,
      });

      testDomainId = await DomainOperations.create({
        account_id: accountId,
        name: 'perm.test.com',
        third_id: '',
        record_count: 0,
      });

      testTeamId = await TeamOperations.create({
        name: 'Perm Test Team',
        description: '',
        created_by: testUserId,
      });
    });

    it('should create a domain permission for user', async () => {
      await DomainPermissionOperations.create({
        domain_id: testDomainId,
        user_id: testUserId,
        permission: 'read',
        sub: '@',
      });
      
      const permissions = await DomainPermissionOperations.getByDomainId(testDomainId);
      assert.ok(permissions.length >= 1, 'Should have at least one permission');
      testPermissionId = permissions[0].id as number;
    });

    it('should get permissions by domain ID', async () => {
      const permissions = await DomainPermissionOperations.getByDomainId(testDomainId);
      
      assert.ok(Array.isArray(permissions), 'Should return an array');
    });

    it('should get permissions by domain and user', async () => {
      const permissions = await DomainPermissionOperations.getByDomainAndUser(testDomainId, testUserId);
      
      assert.ok(Array.isArray(permissions), 'Should return an array');
      assert.ok(permissions.length >= 1, 'Should have at least one permission');
    });

    it('should check if domain has rules', async () => {
      const hasRules = await DomainPermissionOperations.hasRules(testDomainId);
      
      assert.strictEqual(hasRules, true, 'Domain should have rules');
    });

    it('should create a team permission', async () => {
      await DomainPermissionOperations.create({
        domain_id: testDomainId,
        team_id: testTeamId,
        permission: 'write',
        sub: '',
      });
      
      const permissions = await DomainPermissionOperations.getByTeamId(testTeamId);
      assert.ok(permissions.length >= 1, 'Should have team permissions');
    });

    it('should get permissions by team ID', async () => {
      const permissions = await DomainPermissionOperations.getByTeamId(testTeamId);
      
      assert.ok(Array.isArray(permissions), 'Should return an array');
      assert.ok(permissions.every(p => p.team_id === testTeamId), 'All permissions should belong to the team');
    });

    it('should update permission', async () => {
      await DomainPermissionOperations.updatePermission(testPermissionId, 'write');
      
      const permissions = await DomainPermissionOperations.getByDomainId(testDomainId);
      const updated = permissions.find(p => p.id === testPermissionId);
      assert.strictEqual(updated?.permission, 'write');
    });

    it('should delete permission', async () => {
      const id = await DomainPermissionOperations.create({
        domain_id: testDomainId,
        user_id: testUserId,
        permission: 'read',
        sub: 'www',
      }) as number;
      
      await DomainPermissionOperations.delete(id);
      
      const permissions = await DomainPermissionOperations.getByDomainId(testDomainId);
      const deleted = permissions.find(p => p.id === id);
      assert.strictEqual(deleted, undefined, 'Permission should be deleted');
    });
  });

  describe('TokenOperations', () => {
    let testTokenId: number;
    let testUserId: number;

    before(async () => {
      testUserId = await UserOperations.create({
        username: 'tokentestuser',
        nickname: 'Token Test User',
        email: 'token@example.com',
        password_hash: 'hashed',
        role: 'member',
        role_level: 1,
      });
    });

    it('should create a token', async () => {
      const id = await TokenOperations.create({
        user_id: testUserId,
        name: 'Test Token',
        token_hash: 'abc123hash',
        allowed_domains: JSON.stringify([1, 2, 3]),
        allowed_services: JSON.stringify(['domains.read', 'records.write']),
        start_time: null,
        end_time: null,
        max_role: 2,
      });
      
      assert.ok(id > 0, 'Token ID should be greater than 0');
      testTokenId = id;
    });

    it('should get token by ID', async () => {
      const token = await TokenOperations.getById(testTokenId);
      
      assert.ok(token, 'Token should exist');
      assert.strictEqual(token?.name, 'Test Token');
    });

    it('should get token by hash', async () => {
      const token = await TokenOperations.getByTokenHash('abc123hash');
      
      assert.ok(token, 'Token should exist');
      assert.strictEqual(token?.user_id, testUserId);
    });

    it('should get tokens by user ID', async () => {
      const tokens = await TokenOperations.getByUserId(testUserId);
      
      assert.ok(Array.isArray(tokens), 'Should return an array');
      assert.ok(tokens.length >= 1, 'Should have at least one token');
    });

    it('should update last used time', async () => {
      await TokenOperations.updateLastUsed(testTokenId);
      
      const token = await TokenOperations.getById(testTokenId);
      assert.ok(token?.last_used_at, 'Token should have last_used_at set');
    });

    it('should toggle token status', async () => {
      await TokenOperations.toggleStatusByUser(testTokenId, testUserId, false);
      
      const token = await TokenOperations.getById(testTokenId);
      assert.strictEqual(token?.is_active, 0, 'Token should be inactive');
      
      await TokenOperations.toggleStatusByUser(testTokenId, testUserId, true);
      
      const token2 = await TokenOperations.getById(testTokenId);
      assert.strictEqual(token2?.is_active, 1, 'Token should be active');
    });

    it('should delete token by user', async () => {
      const id = await TokenOperations.create({
        user_id: testUserId,
        name: 'Delete Test Token',
        token_hash: 'deletehash',
        allowed_domains: '[]',
        allowed_services: '[]',
        start_time: null,
        end_time: null,
        max_role: 1,
      });
      
      await TokenOperations.deleteByUser(id, testUserId);
      
      const token = await TokenOperations.getById(id);
      assert.strictEqual(token, undefined, 'Token should be deleted');
    });
  });

  describe('SecretOperations', () => {
    it('should ensure runtime secrets table exists', async () => {
      await SecretOperations.ensureRuntimeSecretsTable();
      
      // If no error is thrown, the table exists
      assert.ok(true, 'Table should exist');
    });

    it('should set and get runtime secret', async () => {
      await SecretOperations.setRuntimeSecret('test_key', 'test_value');
      
      const value = await SecretOperations.getRuntimeSecret('test_key');
      assert.strictEqual(value, 'test_value');
    });

    it('should update existing runtime secret', async () => {
      await SecretOperations.setRuntimeSecret('update_key', 'original_value');
      await SecretOperations.setRuntimeSecret('update_key', 'updated_value');
      
      const value = await SecretOperations.getRuntimeSecret('update_key');
      assert.strictEqual(value, 'updated_value');
    });

    it('should return undefined for non-existent secret', async () => {
      const value = await SecretOperations.getRuntimeSecret('non_existent_key');
      assert.strictEqual(value, undefined);
    });
  });

  describe('SettingsOperations', () => {
    it('should set a setting', async () => {
      await SettingsOperations.set('test_setting', 'test_value');
      
      const value = await SettingsOperations.get('test_setting');
      assert.strictEqual(value, 'test_value');
    });

    it('should update a setting', async () => {
      await SettingsOperations.set('update_setting', 'original');
      await SettingsOperations.set('update_setting', 'updated');
      
      const value = await SettingsOperations.get('update_setting');
      assert.strictEqual(value, 'updated');
    });

    it('should return undefined for non-existent setting', async () => {
      const value = await SettingsOperations.get('non_existent_setting');
      assert.strictEqual(value, undefined);
    });

    it('should get and set JSON settings', async () => {
      const testData = { key1: 'value1', key2: 123 };
      await SettingsOperations.setJson('json_setting', testData);
      
      const value = await SettingsOperations.getJson('json_setting', {});
      assert.deepStrictEqual(value, testData);
    });

    it('should return default value for non-existent JSON setting', async () => {
      const defaultValue = { default: true };
      const value = await SettingsOperations.getJson('non_existent_json', defaultValue);
      assert.deepStrictEqual(value, defaultValue);
    });
  });
});
