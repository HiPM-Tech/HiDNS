import { describe, expect, it } from 'vitest';
import {
  argText, draftToNode, findUnnamedAction, literalArg, looksPrivateOrigin, nodeToDraft,
  parseConditionJson, readActionRows, writeActionNodes, type ConditionDraft,
} from '../workflow-dsl';
import type { WorkflowDslNode } from '../workflows-api';

/**
 * 互转层的单测：可视化表单与 DSL 之间「不丢字段」是这次改造的硬约束，
 * 而这类问题只在特定形状（引用实参、assign 包装、logic/not、in 数组）下才暴露，
 * 用组件测试很难覆盖全，所以按纯函数逐形状固定下来。
 */

describe('动作：DSL ↔ 表单行', () => {
  it('call 与 assign(call) 都能读到动作名与实参', () => {
    const rows = readActionRows([
      { kind: 'call', action: 'dns.record.create', args: { domain: { kind: 'literal', value: 'example.com' } } },
      { kind: 'assign', key: 'digest', value: { kind: 'call', action: 'ext.plan', args: {} } },
    ]);
    expect(rows[0]).toMatchObject({ kind: 'dns.record.create' });
    expect(argText(rows[0].args.domain)).toBe('example.com');
    expect(rows[1].saveAs).toBe('digest');
    expect(rows[1].kind).toBe('ext.plan');
  });

  it('认不出的节点原样保留，不被表单吞掉', () => {
    const legacy = { kind: 'notify.email', to: 'ops@example.com' };
    const rows = readActionRows([legacy]);
    expect(rows[0].raw).toEqual(legacy);
    // 序列化必须逐字回写：旧数据里这种简化形状仍要能存回去
    expect(writeActionNodes(rows)).toEqual([legacy]);
  });

  it('往返保持引用节点不被改成字面量', () => {
    const nodes = [{ kind: 'call', action: 'dns.record.update', args: { value: { kind: 'ref', path: 'event.record.value' } } }];
    expect(writeActionNodes(readActionRows(nodes))).toEqual(nodes);
  });

  it('空字面量不写进 DSL（避免必填项"看着已填"）', () => {
    const nodes = writeActionNodes([
      { kind: 'dns.record.create', args: { domain: { kind: 'literal', value: '' }, name: { kind: 'literal', value: 'www' } } },
    ]);
    expect(nodes[0]).toEqual({ kind: 'call', action: 'dns.record.create', args: { name: { kind: 'literal', value: 'www' } } });
  });

  it('数字参数存成 number，不是字符串', () => {
    expect(literalArg('number', '300')).toEqual({ kind: 'literal', value: 300 });
    expect(literalArg('boolean', 'true')).toEqual({ kind: 'literal', value: true });
    expect(literalArg('text', 'A')).toEqual({ kind: 'literal', value: 'A' });
  });

  it('没选动作类型的行能被定位，用于保存前拦截', () => {
    expect(findUnnamedAction([{ kind: 'a.b', args: {} }])).toBeNull();
    expect(findUnnamedAction([{ kind: 'a.b', args: {} }, { kind: '', args: {} }])).toBe(1);
  });

  it('私网/回环地址能被识别（只做提示，权威判定在服务端）', () => {
    expect(looksPrivateOrigin('127.0.0.1')).toBe(true);
    expect(looksPrivateOrigin('192.168.1.10:8080')).toBe(true);
    expect(looksPrivateOrigin('http://localhost/x')).toBe(true);
    expect(looksPrivateOrigin('203.0.113.10')).toBe(false);
    expect(looksPrivateOrigin('origin.example.com')).toBe(false);
  });
});

describe('条件：可视化 ↔ JSON 互转', () => {
  const cases: Array<[string, WorkflowDslNode]> = [
    ['单条 compare', {
      kind: 'compare', op: '==',
      left: { kind: 'ref', path: 'event.record.type' },
      right: { kind: 'literal', value: 'A' },
    }],
    ['数字字段（30 必须是 number）', {
      kind: 'compare', op: '<=',
      left: { kind: 'ref', path: 'event.daysLeft' },
      right: { kind: 'literal', value: 30 },
    }],
    ['in 数组', {
      kind: 'compare', op: 'in',
      left: { kind: 'ref', path: 'event.record.type' },
      right: { kind: 'literal', value: ['A', 'AAAA'] },
    }],
    ['多条 and', {
      kind: 'logic', op: 'and', args: [
        { kind: 'compare', op: '==', left: { kind: 'ref', path: 'event.record.type' }, right: { kind: 'literal', value: 'A' } },
        { kind: 'compare', op: '==', left: { kind: 'ref', path: 'event.domain.name' }, right: { kind: 'literal', value: 'example.com' } },
      ],
    }],
    ['多条 or', {
      kind: 'logic', op: 'or', args: [
        { kind: 'compare', op: '!=', left: { kind: 'ref', path: 'event.record.name' }, right: { kind: 'literal', value: 'www' } },
        { kind: 'compare', op: '==', left: { kind: 'ref', path: 'event.record.fqdn' }, right: { kind: 'literal', value: 'ddns.example.com' } },
      ],
    }],
    ['取反', {
      kind: 'logic', op: 'not', args: [{
        kind: 'compare', op: '==', left: { kind: 'ref', path: 'event.record.type' }, right: { kind: 'literal', value: 'TXT' },
      }],
    }],
  ];

  it.each(cases)('%s 往返后与原文完全一致', (_name, node) => {
    const draft = nodeToDraft(node);
    expect(draft).not.toBeNull();
    expect(draftToNode(draft as ConditionDraft)).toEqual(node);
  });

  it('表单编辑只改动对应字段，其它条件与取反结构都在', () => {
    const node = {
      kind: 'logic', op: 'not', args: [{
        kind: 'logic', op: 'and', args: [
          { kind: 'compare', op: '==', left: { kind: 'ref', path: 'event.record.type' }, right: { kind: 'literal', value: 'A' } },
          { kind: 'compare', op: '==', left: { kind: 'ref', path: 'event.domain.name' }, right: { kind: 'literal', value: 'example.com' } },
        ],
      }],
    };
    const draft = nodeToDraft(node) as ConditionDraft;
    const edited = draftToNode({ ...draft, rows: draft.rows.map((row, index) => (index === 0 ? { ...row, value: 'AAAA' } : row)) });
    expect(edited).toEqual({
      kind: 'logic', op: 'not', args: [{
        kind: 'logic', op: 'and', args: [
          { kind: 'compare', op: '==', left: { kind: 'ref', path: 'event.record.type' }, right: { kind: 'literal', value: 'AAAA' } },
          { kind: 'compare', op: '==', left: { kind: 'ref', path: 'event.domain.name' }, right: { kind: 'literal', value: 'example.com' } },
        ],
      }],
    });
  });

  it('无法无损表达的条件不转表单（保持 JSON 原样）', () => {
    // 含算术：表单表达不了
    expect(nodeToDraft({
      kind: 'compare', op: '>',
      left: { kind: 'ref', path: 'event.daysLeft' },
      right: { kind: 'arith', op: '+', left: { kind: 'literal', value: 1 }, right: { kind: 'literal', value: 2 } },
    })).toBeNull();
    // 字面量里带逗号：'a,b'.split(', ') 会被拆成两个值
    expect(nodeToDraft({
      kind: 'compare', op: '==',
      left: { kind: 'ref', path: 'event.record.value' },
      right: { kind: 'literal', value: 'a,b' },
    })).toBeNull();
    // 单条的 logic/and 求值器不允许（至少要 2 个操作数）
    expect(nodeToDraft({
      kind: 'logic', op: 'and', args: [
        { kind: 'compare', op: '==', left: { kind: 'ref', path: 'event.record.type' }, right: { kind: 'literal', value: 'A' } },
      ],
    })).toBeNull();
  });

  it('JSON 解析：空串是无条件，语法错要能说出原因', () => {
    expect(parseConditionJson('')).toEqual({ ok: true, node: null });
    const broken = parseConditionJson('{oops}');
    expect(broken.ok).toBe(false);
    // 数组与标量都不是条件节点：后端求值器只认带 kind 的对象
    expect(parseConditionJson('[]').ok).toBe(false);
    expect(parseConditionJson('{"kind":"compare"}')).toEqual({ ok: true, node: { kind: 'compare' } });
  });
});