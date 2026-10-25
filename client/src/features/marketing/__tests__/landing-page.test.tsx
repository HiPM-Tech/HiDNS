import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { LandingPage } from '../landing-page';

describe('LandingPage', () => {
  it('展示主标题、能力卡与进入控制台入口', () => {
    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>,
    );

    expect(screen.getByText(/把散落在各家的 DNS/)).toBeTruthy();
    expect(screen.getByText('多提供商聚合')).toBeTruthy();
    expect(screen.getByText('DDNS 与故障转移')).toBeTruthy();
    const links = screen.getAllByRole('link', { name: /进入控制台|登录控制台|开始使用/ });
    expect(links.every((link) => link.getAttribute('href') === '/login')).toBe(true);
  });
});
