import { describe, it, expect } from 'vitest';
import { findMissingRequiredArg, formatDuration, fromDslNodes, parseServerTime, summarizeTriggerEvent, toDslNodes } from './workflows';

describe('parseServerTime', () => {
  it('把无时区后缀的服务端时间按 UTC 解析', () => {
    // 服务端存的就是 UTC；按本地解析会整体偏移一个时区
    expect(parseServerTime('2026-10-21 09:00:00')?.toISOString()).toBe('2026-10-21T09:00:00.000Z');
  });

  it('带时区的 ISO 串原样解析', () => {
    expect(parseServerTime('2026-10-21T09:00:00+08:00')?.toISOString()).toBe('2026-10-21T01:00:00.000Z');
  });

  it('空值与非法值返回 null', () => {
    expect(parseServerTime(null)).toBeNull();
    expect(parseServerTime('')).toBeNull();
    expect(parseServerTime('not-a-date')).toBeNull();
  });
});

describe('formatDuration', () => {
  it('毫秒级直接给 ms', () => {
    expect(formatDuration('2026-10-21 09:00:00', '2026-10-21 09:00:00')).toBe('0 ms');
  });

  it('秒级保留一位小数', () => {
    expect(formatDuration('2026-10-21 09:00:00', '2026-10-21 09:00:01')).toBe('1.0 s');
  });

  it('未结束显示 …，与「没有记录」区分开', () => {
    expect(formatDuration('2026-10-21 09:00:00', null)).toBe('…');
    expect(formatDuration(null, null)).toBe('-');
  });
});

describe('summarizeTriggerEvent', () => {
  const labelOf = (type: string) => (type === 'record.changed' ? '解析记录变更' : type);

  it('拼出可读摘要而不是铺 JSON', () => {
    const raw = JSON.stringify({ type: 'record.changed', domain: { name: 'example.com' }, record: { name: 'www', type: 'A' } });
    expect(summarizeTriggerEvent(raw, labelOf)).toBe('解析记录变更 · example.com · www A');
  });

  it('缺字段时只拼有的部分', () => {
    expect(summarizeTriggerEvent(JSON.stringify({ type: 'record.changed' }), labelOf)).toBe('解析记录变更');
  });

  it('空值与坏 JSON 都返回 -，不抛', () => {
    expect(summarizeTriggerEvent(null, labelOf)).toBe('-');
    expect(summarizeTriggerEvent('{oops', labelOf)).toBe('-');
  });
});

describe('findMissingRequiredArg', () => {
  const lookup = (action: string) =>
    action === 'dns.record.list'
      ? { params: [{ key: 'domainId', required: true }, { key: 'type', required: false }] }
      : undefined;

  it('必填项留空时报出动作与参数', () => {
    expect(findMissingRequiredArg([{ action: 'dns.record.list', args: {} }], lookup)).toEqual({
      action: 'dns.record.list',
      param: 'domainId',
    });
  });

  it('纯空白也算没填', () => {
    expect(findMissingRequiredArg([{ action: 'dns.record.list', args: { domainId: { kind: 'literal', value: '   ' } } }], lookup)).toEqual({
      action: 'dns.record.list',
      param: 'domainId',
    });
  });

  it('填了就通过', () => {
    expect(findMissingRequiredArg([{ action: 'dns.record.list', args: { domainId: { kind: 'literal', value: '1' } } }], lookup)).toBeNull();
  });

  it('引用事件字段也算填了', () => {
    expect(
      findMissingRequiredArg([{ action: 'dns.record.list', args: { domainId: { kind: 'ref', value: 'event.record.value' } } }], lookup),
    ).toBeNull();
  });

  it('空行与未知动作跳过，不误报', () => {
    expect(findMissingRequiredArg([{ action: '', args: {} }, { action: 'unknown.act', args: {} }], lookup)).toBeNull();
  });
});

describe('toDslNodes / fromDslNodes', () => {
  it('字面量与事件引用分别序列化成 literal / ref', () => {
    const nodes = toDslNodes([
      {
        action: 'dns.record.update',
        args: {
          recordId: { kind: 'literal', value: '42' },
          value: { kind: 'ref', value: 'event.record.value' },
          empty: { kind: 'literal', value: '' },
        },
      },
    ]);
    expect(nodes[0]).toEqual({
      kind: 'call',
      action: 'dns.record.update',
      args: {
        recordId: { kind: 'literal', value: '42' },
        value: { kind: 'ref', path: 'event.record.value' },
      },
    });
  });

  it('反序列化能把 ref 还原回来', () => {
    const rows = fromDslNodes([
      { kind: 'call', action: 'dns.record.update', args: { value: { kind: 'ref', path: 'event.record.value' } } },
    ]);
    expect(rows[0].args.value).toEqual({ kind: 'ref', value: 'event.record.value' });
  });
});
