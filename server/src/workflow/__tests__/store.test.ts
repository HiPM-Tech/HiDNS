import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rowToStored, storedToDefinition, listByOwner, getStoredById } from '../store';
import type { RecordChangedTrigger } from '../engine';

function recordTrigger(def: { trigger: { type: string } }): RecordChangedTrigger {
  return def.trigger as RecordChangedTrigger;
}
import type { WorkflowRow } from '../../db/bal/business-adapter';

function row(overrides: Partial<WorkflowRow> = {}): WorkflowRow {
  return {
    id: 7,
    name: 'wf',
    owner_id: 3,
    enabled: 1,
    trigger_type: 'record.changed',
    trigger_config: JSON.stringify({ recordTypes: ['A'] }),
    definition: JSON.stringify({
      condition: { kind: 'literal', value: true },
      actions: [{ kind: 'call', action: 'dns.record.update', args: {} }],
    }),
    created_at: '2026-10-19T00:00:00.000Z',
    updated_at: '2026-10-19T00:00:00.000Z',
    ...overrides,
  };
}

describe('工作流持久化映射', () => {
  it('行 → 存储对象', () => {
    const stored = rowToStored(row());
    expect(stored.enabled).toBe(true);
    expect(stored.triggerConfig.recordTypes).toEqual(['A']);
    expect(stored.actions).toHaveLength(1);
  });

  it('存储对象 → 引擎定义', () => {
    const def = storedToDefinition(rowToStored(row()));
    expect(def.id).toBe('7');
    expect(recordTrigger(def).recordTypes).toEqual(['A']);
    expect(def.actions).toHaveLength(1);
  });

  it('非 A/AAAA 的触发类型被过滤（fail-closed）', () => {
    const def = storedToDefinition(
      rowToStored(row({ trigger_config: JSON.stringify({ recordTypes: ['CNAME', 'TXT'] }) })),
    );
    expect(recordTrigger(def).recordTypes).toEqual([]);
  });

  it('definition 语法损坏视为损坏数据（fail-closed）', () => {
    // 截断/半写入是最常见的损坏形态：回落成空定义会变成「每次触发都成功但什么都不做」
    expect(() => rowToStored(row({ definition: '{not json' }))).toThrowError(/definition 非法/);
  });

  it('definition 缺失按空定义处理', () => {
    const empty = rowToStored(row({ definition: '' }));
    expect(empty.actions).toEqual([]);
    expect(empty.condition).toBeUndefined();
  });

  it('trigger_config 缺失回退默认 A/AAAA', () => {
    const broken = rowToStored(row({ trigger_config: null }));
    expect(broken.triggerConfig).toEqual({});
    expect(recordTrigger(storedToDefinition(broken)).recordTypes).toEqual(['A', 'AAAA']);
  });

  it('trigger_type 非法视为损坏数据', () => {
    expect(() => rowToStored(row({ trigger_type: 'schedule' }))).toThrowError(/trigger_type 非法/);
  });

  it('disabled 映射为 false', () => {
    expect(rowToStored(row({ enabled: 0 })).enabled).toBe(false);
  });
});
describe('损坏数据的隔离与错误映射', () => {
  it('rowToStored 对非数组 actions 抛错', () => {
    const bad = { ...(row() as unknown as Record<string, unknown>), definition: JSON.stringify({ actions: 'oops' }) };
    expect(() => rowToStored(bad as never)).toThrowError(/definition\.actions 必须是数组/);
  });

  it('rowToStored 对非对象 condition 抛错', () => {
    const bad = { ...(row() as unknown as Record<string, unknown>), definition: JSON.stringify({ condition: 'true' }) };
    expect(() => rowToStored(bad as never)).toThrowError(/definition\.condition 必须是对象/);
  });
});
describe('读路径的归一化与容错', () => {
  it('condition:null 归一化为 undefined，不判损坏', () => {
    const stored = rowToStored(row({ definition: JSON.stringify({ condition: null, actions: [] }) }));
    expect(stored.condition).toBeUndefined();
    expect(stored.actions).toEqual([]);
  });

  it('condition 为非对象（数组/字符串）仍 fail-closed', () => {
    expect(() => rowToStored(row({ definition: JSON.stringify({ condition: [] }) }))).toThrowError(/condition 必须是对象/);
    expect(() => rowToStored(row({ definition: JSON.stringify({ condition: 'true' }) }))).toThrowError(/condition 必须是对象/);
  });

  it('trigger_config 非法 JSON 抛错（fail-closed）', () => {
    expect(() => rowToStored(row({ trigger_config: '{broken' }))).toThrowError(/trigger_config 不是合法 JSON/);
    expect(() => rowToStored(row({ trigger_config: '[]' }))).toThrowError(/trigger_config 必须是对象/);
  });

  it('trigger_config 为空回退默认（视为缺失）', () => {
    const stored = rowToStored(row({ trigger_config: '' }));
    expect(stored.triggerConfig).toEqual({});
  });
});