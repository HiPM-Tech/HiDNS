import { describe, it, expect } from 'vitest';
import { findInvalidVarName, needsRecordTypes, resolveEventRef, findMissingRequiredArg, formatDuration, fromConditionNode, fromDslNodes, parseServerTime, summarizeTriggerEvent, toConditionNode, toDslNodes } from './workflows';

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

describe('条件的多条件组合', () => {
  const compare = (path: string, op: string, value: unknown) => ({
    kind: 'compare',
    op,
    left: { kind: 'ref', path },
    right: { kind: 'literal', value },
  });

  it('单条 compare 还原成一行，不带 logic', () => {
    const draft = fromConditionNode(compare('event.record.type', '==', 'A') as never);
    expect(draft.raw).toBeUndefined();
    expect(draft.rows).toHaveLength(1);
    expect(draft.rows[0]).toEqual({ field: 'event.record.type', op: '==', value: 'A' });
  });

  it('and 组合还原成多行并保留连接方式', () => {
    const node = {
      kind: 'logic',
      op: 'and',
      args: [compare('event.record.type', '==', 'A'), compare('event.domain.name', '==', 'example.com')],
    };
    const draft = fromConditionNode(node as never);
    expect(draft.raw).toBeUndefined();
    expect(draft.join).toBe('and');
    expect(draft.rows).toHaveLength(2);
  });

  it('两行序列化成 logic，一行序列化成 compare', () => {
    const two = toConditionNode({
      enabled: true,
      join: 'or',
      negate: false,
      rows: [
        { field: 'event.record.type', op: '==', value: 'A' },
        { field: 'event.record.type', op: '==', value: 'AAAA' },
      ],
    });
    expect(two).toMatchObject({ kind: 'logic', op: 'or' });
    expect((two as unknown as { args: unknown[] }).args).toHaveLength(2);

    const one = toConditionNode({ enabled: true, join: 'and', negate: false, rows: [{ field: 'event.record.type', op: '==', value: 'A' }] });
    expect(one).toMatchObject({ kind: 'compare' });
  });

  it('logic 里混了表单表达不了的节点时整节点保留', () => {
    const node = {
      kind: 'logic',
      op: 'and',
      args: [compare('event.record.type', '==', 'A'), { kind: 'arith', op: '+', args: [] }],
    };
    const draft = fromConditionNode(node as never);
    expect(draft.raw).toBe(node);
  });

  it('表单表达不了的根节点（如算术）原样保留', () => {
    // not 现在已支持取反，这条改用 arith 覆盖 raw 兜底路径
    const node = { kind: 'arith', op: '+', args: [] };
    expect(fromConditionNode(node as never).raw).toBe(node);
  });

  it('关闭条件时不产出任何节点', () => {
    expect(toConditionNode({ enabled: false, join: 'and', negate: false, rows: [] })).toBeUndefined();
  });
});

describe('条件取反（logic/not）', () => {
  const compare = (value: unknown) => ({
    kind: 'compare',
    op: '==',
    left: { kind: 'ref', path: 'event.record.type' },
    right: { kind: 'literal', value },
  });

  it('取反时包一层 not', () => {
    const node = toConditionNode({
      enabled: true,
      join: 'and',
      negate: true,
      rows: [{ field: 'event.record.type', op: '==', value: 'A' }],
    });
    expect(node).toMatchObject({ kind: 'logic', op: 'not' });
    expect((node as unknown as { args: unknown[] }).args).toHaveLength(1);
  });

  it('不取反时不包 not', () => {
    const node = toConditionNode({
      enabled: true,
      join: 'and',
      negate: false,
      rows: [{ field: 'event.record.type', op: '==', value: 'A' }],
    });
    expect(node).toMatchObject({ kind: 'compare' });
  });

  it('not(compare) 还原成一行并标记取反', () => {
    const draft = fromConditionNode({ kind: 'logic', op: 'not', args: [compare('A')] } as never);
    expect(draft.raw).toBeUndefined();
    expect(draft.negate).toBe(true);
    expect(draft.rows).toHaveLength(1);
  });

  it('not(and(...)) 还原成多行 + 取反', () => {
    const draft = fromConditionNode({
      kind: 'logic',
      op: 'not',
      args: [{ kind: 'logic', op: 'and', args: [compare('A'), compare('AAAA')] }],
    } as never);
    expect(draft.negate).toBe(true);
    expect(draft.join).toBe('and');
    expect(draft.rows).toHaveLength(2);
  });

  it('双层取反抵消', () => {
    const draft = fromConditionNode({
      kind: 'logic',
      op: 'not',
      args: [{ kind: 'logic', op: 'not', args: [compare('A')] }],
    } as never);
    expect(draft.negate).toBe(false);
    expect(draft.rows).toHaveLength(1);
  });

  it('not 的操作数不是 1 个时整节点保留', () => {
    const node = { kind: 'logic', op: 'not', args: [compare('A'), compare('AAAA')] };
    expect(fromConditionNode(node as never).raw).toBe(node);
  });
});

describe('动作结果存变量（assign）', () => {
  it('有 saveAs 时包一层 assign', () => {
    const nodes = toDslNodes([
      { action: 'dns.domain.list', args: {}, saveAs: 'plan' },
      { action: 'dns.domain.list', args: {} },
    ]);
    expect(nodes[0]).toMatchObject({ kind: 'assign', key: 'plan' });
    expect((nodes[0] as unknown as { value: { kind: string } }).value.kind).toBe('call');
    // 没有 saveAs 的保持 call
    expect(nodes[1]).toMatchObject({ kind: 'call' });
  });

  it('assign(call) 能还原成带 saveAs 的行', () => {
    const rows = fromDslNodes([
      { kind: 'assign', key: 'plan', value: { kind: 'call', action: 'dns.domain.list', args: {} } },
    ]);
    expect(rows[0].action).toBe('dns.domain.list');
    expect(rows[0].saveAs).toBe('plan');
  });

  it('变量引用能往返', () => {
    const rows = fromDslNodes([
      { kind: 'call', action: 'notify.channel.send', args: { message: { kind: 'ref', path: 'vars.plan' } } },
    ]);
    expect(rows[0].args.message).toEqual({ kind: 'ref', value: 'vars.plan' });
  });
});

describe('findInvalidVarName', () => {
  it('合法变量名通过', () => {
    expect(findInvalidVarName([{ action: 'a', args: {}, saveAs: 'plan_1' }])).toBeNull();
    expect(findInvalidVarName([{ action: 'a', args: {} }])).toBeNull();
  });

  it('含点号或非法字符被拒', () => {
    expect(findInvalidVarName([{ action: 'a', args: {}, saveAs: 'a.b' }])).toBe('a.b');
    expect(findInvalidVarName([{ action: 'a', args: {}, saveAs: '1abc' }])).toBe('1abc');
  });

  it('原型链关键字被拒', () => {
    expect(findInvalidVarName([{ action: 'a', args: {}, saveAs: '__proto__' }])).toBe('__proto__');
  });
});

describe('needsRecordTypes', () => {
  it('记录变更触发器下没选类型时需要拦截', () => {
    // 空数组会让引擎的 includes 恒为 false，工作流永远不触发
    expect(needsRecordTypes('record.changed', [])).toBe(true);
  });

  it('选了类型就不拦', () => {
    expect(needsRecordTypes('record.changed', ['A'])).toBe(false);
  });

  it('其它触发器不受此限制', () => {
    expect(needsRecordTypes('domain.changed', [])).toBe(false);
  });
});
describe('resolveEventRef', () => {
  const event = { type: 'record.changed', domain: { name: 'example.com' }, record: { name: 'www', type: 'A', value: '1.2.3.4' } };

  it('解析 event.* 路径', () => {
    expect(resolveEventRef(event, 'event.record.value')).toBe('1.2.3.4');
    expect(resolveEventRef(event, 'event.domain.name')).toBe('example.com');
  });

  it('路径不存在时返回 undefined', () => {
    expect(resolveEventRef(event, 'event.record.missing')).toBeUndefined();
  });

  it('vars.* 在编辑期没有真实值', () => {
    expect(resolveEventRef(event, 'vars.plan')).toBeUndefined();
  });

  it('没有样例事件时返回 undefined', () => {
    expect(resolveEventRef(null, 'event.record.value')).toBeUndefined();
  });
});
