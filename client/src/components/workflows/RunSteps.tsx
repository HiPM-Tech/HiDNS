import { Tag } from 'tdesign-react';
import { useI18n } from '../../contexts/I18nContext';

/** 服务端记录的单步结构（见 server/src/workflow/run-steps.ts） */
interface RunStep {
  action: string;
  status: 'success' | 'failed';
  durationMs: number;
  input?: Record<string, unknown>;
  error?: string;
}

/**
 * 运行详情里的逐步记录（设计 §3.6）。
 *
 * 服务端存的是 JSON 字符串；解析失败时明确说「记录损坏」而不是静默不显示——
 * 静默会让排查者以为这次运行没有动作。
 */
export function RunSteps({ raw, labelOf }: { raw?: string | null; labelOf: (action: string) => string }) {
  const { t } = useI18n();

  if (!raw) {
    return <div className="run-steps__empty">{t('workflows.noSteps')}</div>;
  }

  let steps: RunStep[];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    steps = parsed as RunStep[];
  } catch {
    return <div className="run-steps__empty">{t('workflows.stepsCorrupted')}</div>;
  }

  if (steps.length === 0) {
    return <div className="run-steps__empty">{t('workflows.noSteps')}</div>;
  }

  return (
    <div className="run-steps">
      {steps.map((step, index) => {
        const inputEntries = Object.entries(step.input ?? {});
        return (
          <div className="run-steps__row" key={`${step.action}-${index}`}>
            <div className="run-steps__head">
              <span className="run-steps__index">{index + 1}</span>
              <span className="run-steps__action">{labelOf(step.action)}</span>
              <Tag size="small" variant="light" theme={step.status === 'success' ? 'success' : 'danger'}>
                {t(`workflows.runStatus_${step.status}`)}
              </Tag>
              <span className="run-steps__duration">{step.durationMs} ms</span>
            </div>
            {inputEntries.length > 0 ? (
              <div className="run-steps__input">
                {inputEntries
                  .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
                  .join('  ')}
              </div>
            ) : null}
            {step.error ? <div className="run-steps__error">{step.error}</div> : null}
          </div>
        );
      })}
    </div>
  );
}
