import type { RecordLine } from './api';

/**
 * 线路列表由服务端「线路归一中间层」处理（默认线路不出现在列表里，前端只保留「默认线路」选项）。
 * 这里仅负责编辑态展示映射，不再做过滤/去重。
 */
export type { RecordLine };

/** 编辑记录时：等于默认线路的 line 展示为「未指定」（下拉的「默认线路」） */
export function displayLine(recordLine: string | null | undefined, defaultId?: string): string {
  return recordLine && recordLine !== defaultId ? recordLine : '';
}
