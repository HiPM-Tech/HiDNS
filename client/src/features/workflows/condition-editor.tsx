import { useId, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  Badge, Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch,
} from '../../ui';
import {
  CONDITION_FIELDS, CONDITION_OPS, EMPTY_CONDITION_ROW, conditionToJson, draftToNode, nodeToDraft,
  parseConditionJson, type ConditionDraft, type ConditionRow,
} from './workflow-dsl';

/**
 * 条件编辑器：可视化行（字段 / 操作符 / 值）与 JSON 高级输入并存。
 *
 * 关键取舍：JSON 文本是唯一真相，可视化只是它的一个视图。
 * 因此「切到可视化」不是一次状态同步，而是实时解析——也就不存在
 * 「表单和 JSON 各存一份、切来切去把字段丢掉」的经典问题。
 * 反过来，解析不出无损表单（含 arith/cond、带逗号的字面量等）时，
 * 直接禁用可视化而不是硬转，宁可少一个入口也不能改写用户的条件。
 */
export function ConditionEditor({ value, onChange }: {
  /** 条件 JSON 文本；空串表示无条件 */
  value: string;
  onChange: (next: string) => void;
}) {
  // 「优先可视化」是一次性偏好而非受控状态：条件被外部改成不可视化的形态时视图自动落到 JSON，
  // 不需要 effect 回写状态（那会触发 react-hooks/set-state-in-effect）
  const [preferVisual, setPreferVisual] = useState(true);
  const parsed = useMemo(() => parseConditionJson(value), [value]);
  const draft = parsed.ok ? nodeToDraft(parsed.node) : null;
  const visual = preferVisual && draft !== null;

  const commit = (next: ConditionDraft) => {
    // 表单 → JSON：只经过 draftToNode 一条路径，序列化格式与手工编辑保持一致
    onChange(conditionToJson(draftToNode(next)));
  };

  const patchRow = (index: number, patch: Partial<ConditionRow>) => {
    if (!draft) return;
    commit({ ...draft, rows: draft.rows.map((row, position) => (position === index ? { ...row, ...patch } : row)) });
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant={visual ? 'default' : 'outline'} size="sm" disabled={draft === null} onClick={() => setPreferVisual(true)}>
          可视化条件
        </Button>
        <Button variant={visual ? 'outline' : 'default'} size="sm" onClick={() => setPreferVisual(false)}>
          JSON 高级
        </Button>
        {!parsed.ok ? <Badge variant="destructive">JSON 有语法错误</Badge> : null}
        {parsed.ok && draft === null ? (
          <span className="text-xs text-muted-foreground">
            该条件超出可视化能力（算术、三元或含逗号的字面量等），保持 JSON 编辑以免丢字段。
          </span>
        ) : null}
      </div>

      {visual && draft ? (
        <div className="space-y-2">
          {draft.rows.length > 1 ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">多条条件之间</span>
              <Select
                value={draft.join}
                onValueChange={(next) => commit({ ...draft, join: next === 'or' ? 'or' : 'and' })}
              >
                <SelectTrigger className="w-28" aria-label="条件连接方式"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="and">同时满足</SelectItem>
                  <SelectItem value="or">任一满足</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {draft.rows.map((row, index) => (
            <div key={index} className="grid items-center gap-2 sm:grid-cols-[minmax(0,1.4fr)_6.5rem_minmax(0,1fr)_auto]">
              <Select value={row.field} onValueChange={(next) => patchRow(index, { field: next })}>
                <SelectTrigger aria-label={`条件 ${index + 1} 字段`}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CONDITION_FIELDS.map((field) => (
                    <SelectItem key={field.path} value={field.path}>{field.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={row.op} onValueChange={(next) => patchRow(index, { op: next })}>
                <SelectTrigger aria-label={`条件 ${index + 1} 操作符`}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CONDITION_OPS.map((op) => (
                    <SelectItem key={op} value={op}>{op}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                aria-label={`条件 ${index + 1} 值`}
                value={row.value}
                placeholder={row.op === 'in' ? '多个值用英文逗号分隔' : '比较值'}
                onChange={(event) => patchRow(index, { value: event.target.value })}
              />
              <Button
                variant="ghost" size="icon" className="text-destructive hover:bg-destructive/10"
                aria-label={`删除第 ${index + 1} 条条件`}
                disabled={draft.rows.length === 1}
                onClick={() => commit({ ...draft, rows: draft.rows.filter((_, position) => position !== index) })}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline" size="sm"
              onClick={() => commit({ ...draft, rows: [...draft.rows, { ...EMPTY_CONDITION_ROW }] })}
            >
              <Plus className="h-4 w-4" /> 添加条件
            </Button>
            <div className="flex items-center gap-2">
              <Switch
                id="wf-condition-negate"
                checked={draft.negate}
                onCheckedChange={(checked) => commit({ ...draft, negate: checked })}
              />
              <Label htmlFor="wf-condition-negate" className="text-xs">整体取反（不满足以上条件时才执行）</Label>
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="wf-condition-peek" className="text-xs text-muted-foreground">等价的 DSL（只读）</Label>
            <pre id="wf-condition-peek" className="max-h-32 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px]">
              {value || '（无条件）'}
            </pre>
          </div>
        </div>
      ) : (
        <ConditionJson value={value} onChange={onChange} invalid={!parsed.ok} />
      )}
    </div>
  );
}

/** JSON 输入区（textarea 需要自己的 id，抽出来保证 hook 调用点固定） */
function ConditionJson({ value, onChange, invalid }: {
  value: string;
  onChange: (next: string) => void;
  invalid: boolean;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>条件 DSL（JSON，留空表示无条件）</Label>
      <textarea
        id={id}
        aria-invalid={invalid}
        className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs aria-[invalid=true]:border-destructive"
        value={value}
        placeholder={'{"kind":"compare","op":"==","left":{"kind":"ref","path":"event.record.type"},"right":{"kind":"literal","value":"A"}}'}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
