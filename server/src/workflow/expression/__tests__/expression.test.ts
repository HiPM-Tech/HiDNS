import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validateExpression } from '../validate';
import { evaluate, ExpressionError } from '../evaluator';
import type { ExpressionNode } from '../nodes';
import { ALL_ACTIONS } from '../../actions/registry';

const knownActions = new Set(ALL_ACTIONS.map((a) => a.name));

function validate(node: unknown) {
  return validateExpression(node, { knownActions, actionParams: PARAMS });
}

const PARAMS = {
  'dns.record.update': [
    { key: 'domain', required: true },
    { key: 'recordId', required: true },
    { key: 'value', required: true },
  ],
  'dns.record.list': [{ key: 'domain', required: true }],
  'http.outbound.fetch': [
    { key: 'url', required: true },
    { key: 'method', type: 'select' as const, options: ['GET', 'POST'] },
  ],
};

describe('DSL 静态校验', () => {
  it('接受合法表达式', () => {
    const result = validate({
      kind: 'call',
      action: 'dns.record.update',
      args: {
        domain: { kind: 'literal', value: 'a.com' },
        recordId: { kind: 'literal', value: 'r1' },
        value: { kind: 'ref', path: 'event.record.value' },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.actions).toEqual(['dns.record.update']);
  });

  it('拒绝未知节点类型', () => {
    const result = validate({ kind: 'eval', code: 'process.exit(1)' });
    expect(result.ok).toBe(false);
    expect(result.issues[0].code).toBe('UNKNOWN_NODE_KIND');
  });

  it('拒绝动态动作名（非字面量）', () => {
    const result = validate({ kind: 'call', action: { kind: 'ref', path: 'vars.x' }, args: {} });
    expect(result.ok).toBe(false);
    expect(result.issues[0].code).toBe('DYNAMIC_ACTION_NAME');
  });

  it('拒绝未注册动作', () => {
    const result = validate({ kind: 'call', action: 'dns.record.drop', args: {} });
    expect(result.issues.some((i) => i.code === 'UNKNOWN_ACTION')).toBe(true);
  });

  it('拒绝越权引用路径', () => {
    for (const path of ['event.__proto__.x', 'vars.constructor', 'process.env', 'event']) {
      const result = validate({ kind: 'ref', path });
      expect(result.ok).toBe(false);
    }
  });

  it('拒绝超深嵌套', () => {
    let node: Record<string, unknown> = { kind: 'literal', value: 1 };
    for (let i = 0; i < 70; i += 1) {
      node = { kind: 'cond', test: { kind: 'literal', value: true }, then: node, else: { kind: 'literal', value: 0 } };
    }
    const result = validate(node);
    expect(result.issues.some((i) => i.code === 'TOO_DEEP')).toBe(true);
  });

  it('拒绝缺失的必填参数', () => {
    const result = validateExpression(
      { kind: 'call', action: 'dns.record.update', args: { domain: { kind: 'literal', value: 'a.com' } } },
      {
        knownActions,
        actionParams: {
          'dns.record.update': [
            { key: 'domain', required: true },
            { key: 'recordId', required: true },
          ],
        },
      },
    );
    expect(result.issues.filter((i) => i.code === 'MISSING_ARG')).toHaveLength(1);
  });

  it('select 取值不在候选中被拒绝', () => {
    const result = validateExpression(
      { kind: 'call', action: 'http.outbound.fetch', args: { method: { kind: 'literal', value: 'PUT' } } },
      {
        knownActions,
        actionParams: {
          'http.outbound.fetch': [
            { key: 'url', required: true },
            { key: 'method', type: 'select', options: ['GET', 'POST'] },
          ],
        },
      },
    );
    expect(result.issues.some((i) => i.code === 'INVALID_OPTION')).toBe(true);
  });

  it('拒绝超出参数白名单的参数', () => {
    const result = validateExpression(
      { kind: 'call', action: 'dns.record.update', args: { shell: { kind: 'literal', value: 'rm -rf /' } } },
      {
        knownActions,
        actionParams: {
          'dns.record.update': [
            { key: 'domain', required: true },
            { key: 'recordId', required: true },
            { key: 'value', required: true },
          ],
        },
      },
    );
    expect(result.issues.some((i) => i.code === 'UNKNOWN_ARG')).toBe(true);
  });
});

describe('无可执行代码（结构断言）', () => {
  it('workflow 模块内不存在 eval / new Function / vm', () => {
    const root = join(__dirname, '..', '..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts')) files.push(full);
      }
    };
    walk(root);
    const offenders = files.filter((file) => {
      if (file.includes('__tests__')) return false;
      const source = readFileSync(file, 'utf8');
      return /\beval\s*\(|new\s+Function\s*\(|from\s+['"]vm['"]|require\(['"]vm['"]\)/.test(source);
    });
    expect(offenders).toEqual([]);
  });
});

describe('DSL 求值', () => {
  const baseCtx = () => ({
    event: { record: { value: '1.2.3.4', type: 'A' } },
    vars: {} as Record<string, unknown>,
    call: vi.fn(async () => 'ok'),
  });

  it('引用事件字段', async () => {
    const ctx = baseCtx();
    await expect(evaluate({ kind: 'ref', path: 'event.record.value' }, ctx)).resolves.toBe('1.2.3.4');
  });

  it('缺失路径返回 undefined 而非抛错', async () => {
    const ctx = baseCtx();
    await expect(evaluate({ kind: 'ref', path: 'event.missing.deep' }, ctx)).resolves.toBeUndefined();
  });

  it('条件与逻辑求值', async () => {
    const ctx = baseCtx();
    const node: ExpressionNode = {
      kind: 'cond',
      test: {
        kind: 'compare',
        op: '==',
        left: { kind: 'ref', path: 'event.record.type' },
        right: { kind: 'literal', value: 'A' },
      },
      then: { kind: 'literal', value: 'ipv4' },
      else: { kind: 'literal', value: 'other' },
    };
    await expect(evaluate(node, ctx)).resolves.toBe('ipv4');
  });

  it('assign 写入局部变量并可被后续引用', async () => {
    const ctx = baseCtx();
    await evaluate({ kind: 'assign', key: 'ip', value: { kind: 'ref', path: 'event.record.value' } }, ctx);
    expect(ctx.vars.ip).toBe('1.2.3.4');
    await expect(evaluate({ kind: 'ref', path: 'vars.ip' }, ctx)).resolves.toBe('1.2.3.4');
  });

  it('call 派发到已注册动作', async () => {
    const ctx = baseCtx();
    const result = await evaluate(
      { kind: 'call', action: 'dns.record.update', args: { value: { kind: 'literal', value: '9.9.9.9' } } },
      ctx,
    );
    expect(result).toBe('ok');
    expect(ctx.call).toHaveBeenCalledWith('dns.record.update', { value: '9.9.9.9' });
  });

  it('调用次数超限抛错', async () => {
    const ctx = baseCtx();
    const node: ExpressionNode = {
      kind: 'logic',
      op: 'and',
      args: Array.from({ length: 51 }, () => ({ kind: 'call' as const, action: 'dns.record.list', args: {} })),
    };
    await expect(evaluate(node, ctx)).rejects.toMatchObject({ code: 'TOO_MANY_CALLS' });
  });

  it('除零抛错', async () => {
    const ctx = baseCtx();
    await expect(
      evaluate({ kind: 'arith', op: '/', left: { kind: 'literal', value: 1 }, right: { kind: 'literal', value: 0 } }, ctx),
    ).rejects.toBeInstanceOf(ExpressionError);
  });

  it('超时中止', async () => {
    let clock = 0;
    const ctx = { ...baseCtx(), now: () => { clock += 10_000; return clock; } };
    await expect(evaluate({ kind: 'literal', value: 1 }, ctx)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});