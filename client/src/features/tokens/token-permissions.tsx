import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui';

/**
 * 令牌服务权限选择器（issue #38）。
 *
 * 取值范围必须与 server/src/service/token-policy.ts 的 KNOWN_SERVICES 完全一致，
 * 后端对白名单外的值直接 400（`unknown allowed_services`），所以这里不提供自由输入。
 *
 * 层级由大到小：
 *   全部权限 (*)
 *     └─ 模块整体 (dns:* / mcp:*)
 *          └─ 具体动作 (dns:read / dns:write …)
 */
const MODULES = [
  { key: 'dns', label: 'DNS 解析', hint: '域名、解析记录、线路、DDNS' },
  { key: 'mcp', label: 'MCP 接口', hint: '供 AI 客户端调用的接口' },
] as const;

const ACTIONS = [
  { key: 'read', label: '只读' },
  { key: 'write', label: '读写' },
  { key: '*', label: '全部动作' },
] as const;

type ActionKey = (typeof ACTIONS)[number]['key'];

export interface TokenPermissionsProps {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}

/** 从已有的表达式数组里解析某个模块的授权级别；null 表示未授权 */
function levelOf(value: string[], moduleKey: string): ActionKey | null {
  if (value.includes('*')) return '*';
  if (value.includes(moduleKey)) return 'write'; // 裸模块名等价于「读写」
  for (const action of ACTIONS) {
    if (value.includes(`${moduleKey}:${action.key}`)) return action.key;
  }
  return null;
}

/** 移除某个模块的所有表达式，保留其它模块与通配符 */
function withoutModule(value: string[], moduleKey: string): string[] {
  return value.filter((item) => item !== moduleKey && !item.startsWith(`${moduleKey}:`));
}

export function TokenPermissions({ value, onChange, disabled }: TokenPermissionsProps) {
  const allSelected = value.includes('*');

  const toggleAll = (checked: boolean) => {
    onChange(checked ? ['*'] : []);
  };

  const toggleModule = (moduleKey: string, checked: boolean) => {
    if (checked) {
      onChange([...withoutModule(value, moduleKey), `${moduleKey}:read`]);
      return;
    }
    onChange(withoutModule(value, moduleKey));
  };

  const setLevel = (moduleKey: string, level: ActionKey) => {
    onChange([...withoutModule(value, moduleKey), `${moduleKey}:${level}`]);
  };

  return (
    <div className="space-y-3">
      <label className={`flex items-start gap-2 rounded-md border border-border px-3 py-2 ${allSelected ? 'bg-accent/40' : ''} ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
        <input
          type="checkbox"
          className="mt-0.5 h-3.5 w-3.5 accent-[hsl(var(--primary))]"
          checked={allSelected}
          disabled={disabled}
          onChange={(event) => toggleAll(event.target.checked)}
        />
        <span className="min-w-0 flex-1">
          <span className="text-sm font-medium">全部权限</span>
          <span className="ml-2 font-mono text-xs text-muted-foreground">*</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">勾选后覆盖下面所有模块，等价于与创建者同权限。</span>
        </span>
      </label>

      <div className={`space-y-2 ${allSelected ? 'opacity-50' : ''}`}>
        {MODULES.map((module) => {
          const level = levelOf(value, module.key);
          const enabled = level !== null;
          return (
            <div key={module.key} className="rounded-md border border-border px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                  checked={enabled}
                  disabled={disabled || allSelected}
                  onChange={(event) => toggleModule(module.key, event.target.checked)}
                />
                <span className="text-sm font-medium">{module.label}</span>
                <span className="font-mono text-xs text-muted-foreground">{module.key}</span>
                <div className="ml-auto w-32">
                  <Select
                    value={level && level !== '*' ? level : level === '*' ? '*' : 'read'}
                    onValueChange={(next) => setLevel(module.key, next as ActionKey)}
                    disabled={disabled || allSelected || !enabled}
                  >
                    <SelectTrigger className="h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ACTIONS.map((action) => (
                        <SelectItem key={action.key} value={action.key}>{action.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{module.hint}</p>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        当前：{value.length === 0 ? '未授权任何服务' : value.map((item) => (
          <span key={item} className="mr-1 font-mono">{item}</span>
        ))}
      </p>
    </div>
  );
}
