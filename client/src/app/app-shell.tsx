import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronLeft, ChevronRight, LogOut, Menu, Monitor, Moon, Sun, UserRound } from 'lucide-react';
import { LogoBadge } from '../ui/logo';
import { cn } from '../ui/cn';
import { Button } from '../ui';
import { copy } from '../copy/zh-CN';
import { navGroups, findNavLabel } from './nav';
import { useRealtimeStatus } from './realtime';
import { applyBackgroundPreference, useThemeMode } from '../lib/theme';
import { usePreferences } from '../features/settings/use-settings';
import { sessionApi } from '../features/session/api';
import { isAdminUser } from '../features/session/use-session';
import type { SessionUser } from '../features/session/api';

const COLLAPSE_KEY = 'hidns.sidebar.collapsed';

interface AppShellProps {
  user: SessionUser;
  children: ReactNode;
}

/** 实时连接状态指示：绿=已连接，黄=重连中，灰=离线（事件不会推送，页面仍有轮询兜底） */
function RealtimeIndicator() {
  const status = useRealtimeStatus();
  const label = status === 'online' ? '实时已连接' : status === 'connecting' ? '实时连接中' : '实时已断开';
  const color = status === 'online' ? 'bg-success-500' : status === 'connecting' ? 'bg-warning-500' : 'bg-muted-foreground';
  return (
    <span className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground" title={label}>
      <span className={cn('h-1.5 w-1.5 rounded-full', color)} aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function AppShell({ user, children }: AppShellProps) {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === '1');
  // 移动端抽屉以「在哪个路由打开的」为状态：路由一变自然关闭，无需 effect 回写
  const [mobileOpenAt, setMobileOpenAt] = useState<string | null>(null);
  const mobileOpen = mobileOpenAt === location.pathname;
  const setMobileOpen = (open: boolean) => setMobileOpenAt(open ? location.pathname : null);
  const { mode, cycle } = useThemeMode();
  // 背景图：默认图在 tokens.css 里，用户偏好在这里覆盖（空=默认，none=关闭）
  const preferences = usePreferences();
  // 控制台用更强蒙层（图退成底纹而不是壁纸），离开控制台时恢复
  useEffect(() => {
    document.documentElement.dataset.surface = 'console';
    return () => { delete document.documentElement.dataset.surface; };
  }, []);
  useEffect(() => {
    applyBackgroundPreference(preferences.data?.backgroundImage);
  }, [preferences.data?.backgroundImage]);

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  const groups = useMemo(
    () => navGroups.map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.adminOnly || isAdminUser(user)),
    })).filter((group) => group.items.length > 0),
    [user],
  );

  const title = findNavLabel(location.pathname);
  const initials = (user.nickname || user.username || '?').slice(0, 1).toUpperCase();
  const ThemeIcon = mode === 'dark' ? Moon : mode === 'light' ? Sun : Monitor;

  return (
    // 外壳本身透明：背景图由 body 铺（见 ui/tokens.css），这里只叠结构面
    <div className="min-h-[var(--shell-h)] text-foreground">
      {/* 跳过导航：键盘/读屏用户不必每次 Tab 穿过 15 个导航项 */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-phi-4 focus:top-phi-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-phi-4 focus:py-phi-2 focus:text-primary-foreground"
      >
        跳到主要内容
      </a>
      {/* 侧边栏 */}
      <aside
        className={cn(
          'fixed left-0 top-0 z-40 flex h-[var(--shell-h)] flex-col border-r border-border bg-card transition-[width,transform] duration-200',
          // 侧栏永远实色：15 个 14px 导航项压在图上一律跌破 4.5:1
          collapsed ? 'w-sidebar-collapsed' : 'w-sidebar',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        )}
      >
        <div className={cn('flex h-header items-center gap-2 border-b border-border px-3', collapsed && 'justify-center px-0')}>
          <LogoBadge size={32} />
          {!collapsed && (
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold leading-tight">{copy.app.name}</p>
              <p className="truncate text-[11px] text-muted-foreground">{copy.app.tagline}</p>
            </div>
          )}
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-3" aria-label="主导航">
          {groups.map((group) => (
            <div key={group.title} className="mb-4 last:mb-0">
              {!collapsed && (
                <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                  {group.title}
                </p>
              )}
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <li key={item.to}>
                      <NavLink
                        to={item.to}
                        end={item.end}
                        title={collapsed ? item.label : undefined}
                        className={({ isActive }) => cn(
                          'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                          collapsed && 'justify-center px-0',
                          isActive
                            ? 'bg-primary/10 font-medium text-primary'
                            : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                        )}
                      >
                        <Icon className="h-4 w-4 shrink-0" aria-hidden />
                        {!collapsed && <span className="truncate">{item.label}</span>}
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-border p-2">
          <Button
            variant="ghost"
            size="sm"
            className={cn('w-full text-muted-foreground', collapsed ? 'justify-center px-0' : 'justify-start')}
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
            {!collapsed && <span className="text-xs">收起</span>}
          </Button>
        </div>
      </aside>

      {mobileOpen && (
        <button
          type="button"
          aria-label="关闭菜单"
          className="fixed inset-0 z-30 bg-foreground/20 backdrop-blur-[1px] lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* 主区域 */}
      <div className={cn('flex min-h-[var(--shell-h)] flex-col transition-[padding] duration-200', collapsed ? 'lg:pl-[var(--w-sidebar-collapsed)]' : 'lg:pl-[var(--w-sidebar)]')}>
        <header className="surface-chrome sticky top-0 z-20 flex h-header items-center gap-2 border-b border-border px-3 lg:px-phi-9">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            aria-label="打开菜单"
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </Button>
          <h1 className="text-caption font-medium text-muted-foreground">{title}</h1>
          <div className="ml-auto flex items-center gap-1">
            <RealtimeIndicator />
            <Button variant="ghost" size="icon" onClick={cycle} aria-label="切换主题" title={`主题：${mode}`}>
              <ThemeIcon className="h-4 w-4" />
            </Button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
                  aria-label="账户菜单"
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                    {initials}
                  </span>
                  <span className="hidden max-w-32 truncate sm:inline">{user.nickname || user.username}</span>
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={6}
                  className="z-50 min-w-48 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md animate-zoom-in"
                >
                  <div className="px-2 py-1.5">
                    <p className="text-sm font-medium">{user.nickname || user.username}</p>
                    <p className="text-xs text-muted-foreground">{user.email || user.role || '—'}</p>
                  </div>
                  <DropdownMenu.Separator className="my-1 h-px bg-border" />
                  <DropdownMenu.Item
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent"
                    onSelect={() => { window.location.assign('/dash/security'); }}
                  >
                    <UserRound className="h-4 w-4" /> 账号与安全
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-destructive outline-none data-[highlighted]:bg-destructive/10"
                    onSelect={() => { void sessionApi.logout(); }}
                  >
                    <LogOut className="h-4 w-4" /> 退出登录
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </header>

        <main id="main-content" className="surface-page flex-1 px-3 py-phi-7 lg:px-phi-9 lg:py-phi-8">
          <div className="mx-auto w-full max-w-content">{children}</div>
        </main>
      </div>
    </div>
  );
}
