import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthCallbackPage } from '../oauth-callback-page';
import { http } from '../../../lib/http';

vi.mock('../../../lib/http', () => ({
  http: { post: vi.fn() },
}));

function renderAt(search: string) {
  return render(
    <MemoryRouter initialEntries={['/oauth/callback' + search]}>
      <Routes>
        <Route path="/oauth/callback" element={<OAuthCallbackPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('OAuthCallbackPage', () => {
  beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); });
  afterEach(() => { sessionStorage.clear(); });

  it('缺少 code/state 时直接报错不请求', () => {
    renderAt('');
    expect(screen.getByText('授权未完成')).toBeTruthy();
    expect(screen.getByText(/缺少 code 或 state/)).toBeTruthy();
    expect(http.post).not.toHaveBeenCalled();
  });

  it('携带 error 参数时展示授权方给出的原因', () => {
    renderAt('?error=access_denied&error_description=user%20cancelled');
    expect(screen.getByText('user cancelled')).toBeTruthy();
    expect(http.post).not.toHaveBeenCalled();
  });

  it('登录模式兑换后提示进入控制台', async () => {
    vi.mocked(http.post).mockResolvedValue({ code: 0, msg: 'success', data: { mode: 'login' } } as never);
    renderAt('?code=abc&state=xyz');

    expect(await screen.findByText('登录成功，正在进入控制台…')).toBeTruthy();
    expect(http.post).toHaveBeenCalledWith('/auth/oauth/callback', { code: 'abc', state: 'xyz' });
    expect(sessionStorage.getItem('oauth_callback_done:abc:xyz')).toBe('login');
  });

  it('绑定模式展示绑定成功，重复访问同一 code 不再兑换', async () => {
    vi.mocked(http.post).mockResolvedValue({ code: 0, msg: 'success', data: { mode: 'bind' } } as never);
    const first = renderAt('?code=dup&state=st');
    expect(await screen.findByText('外部账号绑定成功')).toBeTruthy();
    first.unmount();

    renderAt('?code=dup&state=st');
    expect(await screen.findByText('该授权已完成，无需重复提交。')).toBeTruthy();
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('兑换失败展示服务端原因', async () => {
    vi.mocked(http.post).mockResolvedValue({ code: 401, msg: 'state 已过期', data: null } as never);
    renderAt('?code=abc&state=old');
    expect(await screen.findByText('state 已过期')).toBeTruthy();
    expect(sessionStorage.getItem('oauth_callback_done:abc:old')).toBeNull();
  });
});
