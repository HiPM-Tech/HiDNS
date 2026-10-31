import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';
const STORAGE_KEY = 'theme';

function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return mode;
}

export function applyTheme(mode: ThemeMode): void {
  const resolved = resolveTheme(mode);
  document.documentElement.classList.toggle('dark', resolved === 'dark');
  document.documentElement.style.colorScheme = resolved;
}

function readStoredMode(): ThemeMode {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'auto') return 'system';
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

/** 写回时沿用历史取值（auto 表示跟随系统），保证与旧数据互通 */
function toStoredValue(mode: ThemeMode): string {
  return mode === 'system' ? 'auto' : mode;
}

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: 'light' | 'dark';
  setMode: (mode: ThemeMode) => void;
  cycle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * 主题的唯一来源。
 *
 * 必须包住整个应用（含 /login、/setup、/oauth/*）：此前三处各自 useState 读同一个
 * localStorage 键，互不同步；且公开页没有 Provider，登录页不应用已保存的主题。
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);

  useEffect(() => {
    applyTheme(mode);
    localStorage.setItem(STORAGE_KEY, toStoredValue(mode));
    if (mode !== 'system') return;
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) return;
    const listener = () => applyTheme('system');
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => setModeState(next), []);
  const cycle = useCallback(() => {
    setModeState((current) => (current === 'light' ? 'dark' : current === 'dark' ? 'system' : 'light'));
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolved: resolveTheme(mode), setMode, cycle }),
    [mode, setMode, cycle],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useThemeMode(): ThemeContextValue {
  const context = useContext(ThemeContext);
  // 兜底：脱离 Provider 使用时仍可读当前 DOM 状态，避免整页崩溃
  const fallback = useMemo<ThemeContextValue>(() => ({
    mode: readStoredMode(),
    resolved: resolveTheme(readStoredMode()),
    setMode: (next) => { applyTheme(next); localStorage.setItem(STORAGE_KEY, toStoredValue(next)); },
    cycle: () => undefined,
  }), []);
  return context ?? fallback;
}

/**
 * 把用户偏好里的背景图应用到 :root。
 *
 * 安全要点：背景图是用户输入，会被拼进 CSS 变量——必须走 URL 解析 + 协议白名单，
 * 并用 JSON.stringify 转义，否则 `x'); } body{display:none} .a{ content:('` 这类值
 * 可以破坏整页样式（存储型 CSS 注入）。
 * 取值约定：空 = 用默认图；'none' = 显式关闭背景；其余 = 用户自定义 https/http 图片。
 */
export function applyBackgroundPreference(raw: string | undefined | null): void {
  const root = document.documentElement;
  const value = (raw ?? '').trim();

  if (value === 'none') {
    root.dataset.bg = 'off';
    root.style.removeProperty('--app-bg-image');
    return;
  }

  root.dataset.bg = 'on';
  if (!value) {
    root.style.removeProperty('--app-bg-image');
    return;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    root.style.removeProperty('--app-bg-image');
    return;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    root.style.removeProperty('--app-bg-image');
    return;
  }
  root.style.setProperty('--app-bg-image', 'url(' + JSON.stringify(url.href) + ')');
}

/**
 * 默认背景图来自第三方随机图源（t.hinswu.top/pixiv），自托管/内网实例默认会外连。
 * 构建期可用 `VITE_DEFAULT_BACKGROUND=none` 关掉（不请求、不显示），
 * 运行期仍可在「设置 → 偏好 → 背景图地址」填 `none` 或自定义 URL。
 */
export function applyBuildTimeBackgroundPolicy(): void {
  const flag = (import.meta.env.VITE_DEFAULT_BACKGROUND ?? '').toString().trim().toLowerCase();
  if (flag === 'none' || flag === 'off' || flag === 'false' || flag === '0') {
    const root = document.documentElement;
    root.dataset.bg = 'off';
    root.style.removeProperty('--app-bg-image');
  }
}
