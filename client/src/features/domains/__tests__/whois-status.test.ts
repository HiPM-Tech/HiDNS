import { describe, expect, it } from 'vitest';
import { formatWhoisStatus, whoisStatusVariant } from '../whois-status';

describe('WHOIS 状态翻译', () => {
  it('单状态与多行 EPP 状态都翻译', () => {
    expect(formatWhoisStatus('active')).toBe('正常');
    expect(formatWhoisStatus('ok')).toBe('正常');
    expect(formatWhoisStatus('OK')).toBe('正常');
    expect(formatWhoisStatus('clientTransferProhibited\nclientDeleteProhibited')).toBe('禁止转移 / 禁止删除');
    expect(formatWhoisStatus('redemptionPeriod')).toBe('赎回期');
    expect(formatWhoisStatus('client transfer prohibited')).toBe('禁止转移');
    expect(formatWhoisStatus('client-transfer-prohibited')).toBe('禁止转移');
  });

  it('未知状态原样保留，空值返回空串', () => {
    expect(formatWhoisStatus('someNewStatus')).toBe('someNewStatus');
    expect(formatWhoisStatus(null)).toBe('');
  });

  it('徽标语义色', () => {
    expect(whoisStatusVariant('active')).toBe('success');
    expect(whoisStatusVariant('expired')).toBe('destructive');
    expect(whoisStatusVariant('clientHold')).toBe('warning');
    expect(whoisStatusVariant(null)).toBe('secondary');
  });
});
