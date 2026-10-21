import { describe, it, expect } from 'vitest';
import { formatDuration, parseServerTime, summarizeTriggerEvent } from './workflows';

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
