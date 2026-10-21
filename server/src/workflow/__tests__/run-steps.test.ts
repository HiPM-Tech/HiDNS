import { describe, it, expect } from 'vitest';
import { redactArgs, serializeSteps } from '../run-steps';

describe('运行步骤参数脱敏', () => {
  it('键名像凭据的整条遮掉', () => {
    const out = redactArgs({ token: 'abc', password: 'p', secretKey: 's', apiKey: 'k', domain: 'example.com' });
    expect(out.token).toBe('***');
    expect(out.password).toBe('***');
    expect(out.secretKey).toBe('***');
    expect(out.apiKey).toBe('***');
    expect(out.domain).toBe('example.com');
  });

  it('普通短值原样保留', () => {
    const out = redactArgs({ domainId: 1, target: '1.1.1.1', allowMultiple: false });
    expect(out).toEqual({ domainId: 1, target: '1.1.1.1', allowMultiple: false });
  });

  it('超长字符串截断，避免把整段响应体写进记录', () => {
    const out = redactArgs({ body: 'x'.repeat(500) });
    expect(String(out.body).length).toBe(201);
    expect(String(out.body).endsWith('…')).toBe(true);
  });

  it('对象与数组折叠成占位', () => {
    const out = redactArgs({ records: [1, 2, 3], config: { a: 1 } });
    expect(out.records).toBe('[3 items]');
    expect(out.config).toBe('[object]');
  });
});

describe('serializeSteps', () => {
  it('空步骤返回 null', () => {
    expect(serializeSteps([])).toBeNull();
    expect(serializeSteps(undefined)).toBeNull();
  });

  it('正常序列化', () => {
    const json = serializeSteps([{ action: 'a.b.c', status: 'success', durationMs: 5, input: { x: 1 } }]);
    expect(JSON.parse(String(json))[0].action).toBe('a.b.c');
  });
});
