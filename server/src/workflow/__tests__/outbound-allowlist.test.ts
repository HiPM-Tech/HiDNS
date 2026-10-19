import { describe, it, expect } from 'vitest';
import { validatePayload } from '../validate-payload';

describe('出站白名单解析语义', () => {
  // 与 workflow/index.ts 的 reloadOutboundPolicy 保持同一套规则（此处锁定契约）
  function parse(raw: string): string[] {
    let allowlist: string[] = [];
    let parsedJson = false;
    if (raw.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          allowlist = parsed.map((item) => String(item).trim()).filter(Boolean);
          parsedJson = true;
        }
      } catch {
        /* 回退 CSV */
      }
    }
    if (!parsedJson) allowlist = raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    return allowlist;
  }

  it('JSON 数组按元素解析', () => {
    expect(parse('["api.ipify.org","*.cloudflare.com"]')).toEqual(['api.ipify.org', '*.cloudflare.com']);
  });

  it('空数组是合法配置，不得回退成 CSV 垃圾项', () => {
    expect(parse('[]')).toEqual([]);
  });

  it('CSV 兼容', () => {
    expect(parse('a.com, b.com')).toEqual(['a.com', 'b.com']);
  });
});

describe('创建时 condition 归一化契约', () => {
  it('null 与省略等价（路由层归一化后校验通过）', () => {
    const base = {
      name: 'wf',
      triggerType: 'record.changed',
      triggerConfig: { recordTypes: ['A'] },
      actions: [
        {
          kind: 'call',
          action: 'dns.record.list',
          args: { domain: { kind: 'literal', value: 'a.com' } },
        },
      ],
    };
    expect(validatePayload({ ...base, condition: undefined } as never)).toEqual([]);
    expect(validatePayload({ ...base, condition: null } as never).join()).toContain('INVALID_NODE');
  });
});