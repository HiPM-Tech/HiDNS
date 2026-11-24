import { describe, expect, it } from 'vitest';
import { describeProviderError } from '../provider-errors';

/**
 * 厂商错误的归类。
 *
 * 这条链路的意义：厂商只回一个码（阿里云 RecordValueInvalid、Cloudflare 9003），
 * 前端原本只能把「记录的值不正确」原样显示出来，用户无法判断自己错在哪。
 */
describe('describeProviderError', () => {
  it('值不合法时按记录类型给出具体检查点', () => {
    const r = describeProviderError('InvalidParameter.RecordValueInvalid', { recordType: 'TXT', value: 'a'.repeat(300) });
    expect(r.kind).toBe('value');
    expect(r.hint).toContain('255');
  });

  it('SRV 填 IP 时指出必须是主机名', () => {
    const r = describeProviderError('记录的值不正确', { recordType: 'SRV', value: '10 5 5060 1.2.3.4' });
    expect(r.hint).toContain('主机名');
  });

  it('CNAME 带尾点时提示去掉', () => {
    const r = describeProviderError('9003', { recordType: 'CNAME', value: 'target.example.com.' });
    expect(r.hint).toContain('结尾的点');
  });

  it('重复记录单独归类', () => {
    const r = describeProviderError('DomainRecordDuplicate');
    expect(r.kind).toBe('conflict');
    expect(r.msg).toContain('已存在');
    expect(r.hint).toContain('删除');
  });

  it('凭据问题提示检查 AccessKey', () => {
    const r = describeProviderError('InvalidAccessKeyId.NotFound');
    expect(r.kind).toBe('auth');
    expect(r.hint).toContain('AccessKey');
  });

  it('限流单独归类', () => {
    const r = describeProviderError('Throttling.User');
    expect(r.kind).toBe('rate');
  });

  it('无法归类时保留原始错误，不丢信息', () => {
    const r = describeProviderError('SomeUnknownCode: details');
    expect(r.kind).toBe('unknown');
    expect(r.hint).toContain('SomeUnknownCode');
  });

  it('厂商没给原因时也不返回空提示', () => {
    const r = describeProviderError(undefined);
    expect(r.msg).toBeTruthy();
    expect(r.hint).toBeTruthy();
  });
});
