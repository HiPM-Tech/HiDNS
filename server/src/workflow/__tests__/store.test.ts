import { describe, it, expect } from 'vitest';
import { rowToStored, storedToDefinition } from '../store';
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
    expect(def.trigger.recordTypes).toEqual(['A']);
    expect(def.actions).toHaveLength(1);
  });

  it('非 A/AAAA 的触发类型被过滤（fail-closed）', () => {
    const def = storedToDefinition(
      rowToStored(row({ trigger_config: JSON.stringify({ recordTypes: ['CNAME', 'TXT'] }) })),
    );
    expect(def.trigger.recordTypes).toEqual([]);
  });

  it('缺失或损坏的 JSON 不抛错，回退默认值', () => {
    const broken = rowToStored(row({ definition: '{not json', trigger_config: null }));
    expect(broken.actions).toEqual([]);
    expect(broken.triggerConfig).toEqual({});
    expect(storedToDefinition(broken).trigger.recordTypes).toEqual(['A', 'AAAA']);
  });

  it('disabled 映射为 false', () => {
    expect(rowToStored(row({ enabled: 0 })).enabled).toBe(false);
  });
});