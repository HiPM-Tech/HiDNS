import { describe, expect, it } from 'vitest';
import { readActionRows, writeActionNodes } from '../workflow-dsl';

/**
 * DSL ↔ 可视化表单的实时映射（C 端反馈）：
 * 手写的 args 既支持完整表达式节点，也支持字符串/数字/布尔简写。
 */
describe('workflow-dsl 映射', () => {
  it('完整节点写法可读回', () => {
    const rows = readActionRows([
      { kind: 'call', action: 'dns.record.list', args: { domain: { kind: 'literal', value: 'example.test' } } },
    ]);
    expect(rows[0].kind).toBe('dns.record.list');
    expect((rows[0].args.domain as { value?: unknown }).value).toBe('example.test');
  });

  it('字符串/数字/布尔简写也读回（此前会被静默丢弃）', () => {
    const rows = readActionRows([
      { kind: 'call', action: 'dns.record.list', args: { domain: 'example.test', type: 'A', limit: 10, all: true } },
    ]);
    expect((rows[0].args.domain as { value?: unknown }).value).toBe('example.test');
    expect((rows[0].args.type as { value?: unknown }).value).toBe('A');
    expect((rows[0].args.limit as { value?: unknown }).value).toBe(10);
    expect((rows[0].args.all as { value?: unknown }).value).toBe(true);
  });

  it('写回后再读回保持一致（往返不丢参数）', () => {
    const rows = readActionRows([{ kind: 'call', action: 'dns.record.list', args: { domain: 'example.test' } }]);
    const roundTrip = readActionRows(writeActionNodes(rows));
    expect((roundTrip[0].args.domain as { value?: unknown }).value).toBe('example.test');
  });
});
