import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { TokenServicePicker } from '../token-service-picker';
import type { AllowedServices } from '../permissions';

function Picker({ initial = { dns: ['*'] } }: { initial?: AllowedServices }) {
  const [value, setValue] = useState(initial);
  return <><TokenServicePicker value={value} onChange={setValue} /><output data-testid="permissions">{JSON.stringify(value)}</output></>;
}

describe('TokenServicePicker', () => {
  it('箭头独立展开，不更改服务授权；未启用服务的子权限不可操作', async () => {
    const user = userEvent.setup();
    render(<Picker initial={{}} />);
    expect(screen.queryByRole('button', { name: 'records.read' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '展开 dns 权限' }));
    expect(screen.getByRole('button', { name: '收起 dns 权限' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'records.read' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('permissions').textContent).toBe('{}');
    await user.click(screen.getByRole('button', { name: 'dns 服务' }));
    expect(screen.getByTestId('permissions').textContent).toBe('{"dns":["*"]}');
    expect(screen.getByRole('button', { name: 'records.read' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'records.read' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('小标签选择不隐含读权限，全部取消后恢复 *，收起不丢失选择', async () => {
    const user = userEvent.setup();
    render(<Picker />);
    await user.click(screen.getByRole('button', { name: '展开 dns 权限' }));
    await user.click(screen.getByRole('button', { name: 'records.write' }));
    expect(screen.getByTestId('permissions').textContent).toBe('{"dns":["records.write"]}');
    expect(screen.getByText('已选 1 项')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '收起 dns 权限' }));
    await user.click(screen.getByRole('button', { name: '展开 dns 权限' }));
    expect(screen.getByRole('button', { name: 'records.write' }).getAttribute('aria-pressed')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'records.write' }));
    expect(screen.getByTestId('permissions').textContent).toBe('{"dns":["*"]}');
    expect(screen.getByText('全部权限')).toBeTruthy();
  });

  it('MCP 仅使用通配权限，展开说明不隐式授权', async () => {
    const user = userEvent.setup();
    render(<Picker initial={{}} />);
    await user.click(screen.getByRole('button', { name: '展开 mcp 权限' }));
    expect(screen.getByText(/暂不支持细分/)).toBeTruthy();
    expect(screen.getByTestId('permissions').textContent).toBe('{}');
    await user.click(screen.getByRole('button', { name: 'mcp 服务' }));
    expect(screen.getByTestId('permissions').textContent).toBe('{"mcp":["*"]}');
    await user.click(screen.getByRole('button', { name: 'mcp 服务' }));
    expect(screen.getByTestId('permissions').textContent).toBe('{}');
  });
});
