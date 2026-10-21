import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nProvider } from '../../contexts/I18nContext';
import { RunSteps } from './RunSteps';

function renderSteps(raw?: string | null) {
  return render(
    <I18nProvider>
      <RunSteps raw={raw} labelOf={(name) => (name === 'dns.domain.list' ? '列出域名' : name)} />
    </I18nProvider>,
  );
}

describe('运行步骤展示（设计 §3.6）', () => {
  it('渲染动作可读名、状态、耗时与参数摘要', () => {
    renderSteps(JSON.stringify([{ action: 'dns.domain.list', status: 'success', durationMs: 12, input: { domainId: 1 } }]));
    expect(screen.getByText('列出域名')).toBeTruthy();
    expect(screen.getByText('成功')).toBeTruthy();
    expect(screen.getByText('12 ms')).toBeTruthy();
    expect(screen.getByText(/domainId=1/)).toBeTruthy();
  });

  it('失败步骤显示错误', () => {
    renderSteps(JSON.stringify([{ action: 'dns.domain.list', status: 'failed', durationMs: 3, input: {}, error: '上游拒绝' }]));
    expect(screen.getByText('失败')).toBeTruthy();
    expect(screen.getByText('上游拒绝')).toBeTruthy();
  });

  it('没有记录时明确说明，而不是空白', () => {
    renderSteps(null);
    expect(screen.getByText('这次运行没有动作记录')).toBeTruthy();
  });

  it('记录损坏时明确说明', () => {
    renderSteps('{not-json');
    expect(screen.getByText('步骤记录已损坏，无法解析')).toBeTruthy();
  });
});
