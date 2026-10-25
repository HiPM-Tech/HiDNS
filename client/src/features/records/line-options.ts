import type { RecordLine } from './api';

/** 下拉选项归一：过滤默认线路 id，并按 id 去重（避免「默认」与「默认线路」并存） */
export function normalizeLineOptions(lines: RecordLine[], defaultId?: string): RecordLine[] {
  const seen = new Set<string>();
  return lines.filter((item) => {
    if (!item.id || item.id === defaultId || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

/** 编辑记录时：等于默认线路的 line 展示为「未指定」（下拉的「默认线路」） */
export function displayLine(recordLine: string | null | undefined, defaultId?: string): string {
  return recordLine && recordLine !== defaultId ? recordLine : '';
}
