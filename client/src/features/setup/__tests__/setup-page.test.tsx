import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupPage } from '../setup-page';
import { setupApi } from '../setup-api';

vi.mock('../setup-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../setup-api')>();
  return { ...actual, setupApi: { status: vi.fn(), dbConfig: vi.fn(), testDb: vi.fn(), initDb: vi.fn(), createAdmin: vi.fn() } };
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/setup']}>
      <SetupPage />
    </MemoryRouter>,
  );
}

describe('SetupPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(setupApi.status).mockResolvedValue({ initialized: false, hasUsers: false });
    vi.mocked(setupApi.dbConfig).mockResolvedValue(null);
  });

  it('先测试连接才能进入下一步', async () => {
    const user = userEvent.setup();
    vi.mocked(setupApi.testDb).mockResolvedValue({ success: true });
    renderPage();

    const next = await screen.findByRole('button', { name: '下一步' });
    expect((next as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() => expect(setupApi.testDb).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('连接成功')).toBeTruthy();
    expect((screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('连接失败展示错误且不可继续', async () => {
    const user = userEvent.setup();
    vi.mocked(setupApi.testDb).mockRejectedValue(new Error('ECONNREFUSED'));
    renderPage();

    await user.click(await screen.findByRole('button', { name: '测试连接' }));
    expect(await screen.findByText('ECONNREFUSED')).toBeTruthy();
    expect((screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('初始化后进入管理员步骤并校验表单', async () => {
    const user = userEvent.setup();
    vi.mocked(setupApi.testDb).mockResolvedValue({ success: true });
    vi.mocked(setupApi.initDb).mockResolvedValue({ success: true });
    renderPage();

    await user.click(await screen.findByRole('button', { name: '测试连接' }));
    await waitFor(() => expect((screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: '下一步' }));

    expect(await screen.findByText('创建管理员')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '创建并完成' }));
    expect(await screen.findByText('请填写全部字段')).toBeTruthy();
    expect(setupApi.createAdmin).not.toHaveBeenCalled();
  });

  it('检测到已有数据时提示重置风险', async () => {
    const user = userEvent.setup();
    vi.mocked(setupApi.testDb).mockResolvedValue({ success: true, hasExistingData: true });
    renderPage();

    await user.click(await screen.findByRole('button', { name: '测试连接' }));
    expect(await screen.findByText(/该数据库已有 HiDNS 数据/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '重置并初始化' })).toBeTruthy();
  });
});
