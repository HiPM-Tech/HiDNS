import { describe, expect, it } from 'vitest';
import { accountEventData } from './accountEvent';

describe('account event payload', () => {
  it.each(['{"apiKey":"fixture-secret"}', { apiKey: 'fixture-secret' }])('omits provider config without mutating the account', config => {
    const account = { id: 1, name: 'test', enabled: 1, config };
    const result = accountEventData(account);
    expect(result).toEqual({ id: 1, name: 'test', enabled: 1 });
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
    expect(account.config).toBe(config);
  });
  it('preserves missing accounts', () => {
    expect(accountEventData(null)).toBeNull();
    expect(accountEventData(undefined)).toBeUndefined();
  });
});
