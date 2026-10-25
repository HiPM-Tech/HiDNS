import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AboutPage } from '../about-page';
import { systemApi } from '../../system/api';

vi.mock('../../system/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../system/api')>();
  return { ...actual, systemApi: { info: vi.fn(), version: vi.fn() } };
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AboutPage />
    </QueryClientProvider>,
  );
}

describe('AboutPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(systemApi.version).mockResolvedValue({ version: '2.2.0', deployMode: 'source', node: 'v22.23.3' });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('展示版本、技术栈与仓库入口，GitHub 失败时降级', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 })));
    renderPage();

    expect(await screen.findByText('关于 HiDNS')).toBeTruthy();
    expect(await screen.findByText('v2.2.0')).toBeTruthy();
    expect(screen.getByText('React 19')).toBeTruthy();
    expect(screen.getByText('Tailwind CSS 3.4')).toBeTruthy();
    expect((await screen.findAllByText(/暂时无法获取/)).length).toBeGreaterThanOrEqual(2);
  });

  it('拉取到 Release 与贡献者时正常展示', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('releases/latest')) {
        return { ok: true, json: async () => ({ tag_name: 'v2.2.0', html_url: 'https://github.com/HiPM-Tech/HiDNS/releases/tag/v2.2.0', published_at: '2026-10-20T00:00:00Z' }) };
      }
      return { ok: true, json: async () => [{ login: 'alice', avatar_url: 'https://avatars.example/a.png', html_url: 'https://github.com/alice', contributions: 12 }] };
    }));
    renderPage();

    expect((await screen.findAllByText('v2.2.0')).length).toBeGreaterThan(0);
    expect(await screen.findByText('alice')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
  });
});
