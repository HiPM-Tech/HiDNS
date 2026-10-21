import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button, Dropdown, Input, Layout as TLayout, Popup, Space } from 'tdesign-react';
import type { DropdownOption } from 'tdesign-react';
import {
  ChevronDownIcon,
  CheckIcon,
  DesktopIcon,
  LogoGithubIcon,
  LogoutIcon,
  ModeDarkIcon,
  ModeLightIcon,
  SearchIcon,
  SettingIcon,
  TranslateIcon,
  UserCircleIcon,
  ViewListIcon,
} from 'tdesign-icons-react';
import { useAuth } from '../contexts/AuthContext';
import { useI18n } from '../contexts/I18nContext';
import { useTheme } from '../contexts/ThemeContext';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { localeOptions } from '../i18n';
import { Avatar } from './Avatar';
import { ConfirmDialog } from './ConfirmDialog';
import './Header.css';

interface HeaderProps {
  collapsed: boolean;
  avatarImage?: string | null;
  onMenuClick?: () => void;
  onToggleCollapse?: () => void;
}

interface HeaderSearchItem {
  title: string;
  group: string;
  path: string;
  keywords: string[];
}

export function Header({ collapsed, avatarImage, onMenuClick, onToggleCollapse }: HeaderProps) {
  const { locale, setLocale, t } = useI18n();
  const { user, logout, isAdmin } = useAuth();
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [searchValue, setSearchValue] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchPanelMounted, setSearchPanelMounted] = useState(false);
  const [searchPanelClosing, setSearchPanelClosing] = useState(false);
  const [showTunnels] = useLocalStorage('showTunnels', false);
  const searchBlurTimerRef = useRef<number | null>(null);
  const searchCloseTimerRef = useRef<number | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const segments = location.pathname.split('/').filter(Boolean);
  const displayName = user?.nickname || user?.username || t('common.unknown');

  const normalizedPath = location.pathname.replace(/\/+$/, '') || '/';
  const pageTitleMap: Record<string, string> = {
    '/': t('common.dashboard'),
    '/dash': t('common.dashboard'),
    '/dash/accounts': t('common.dnsAccounts'),
    '/dash/domains': t('domains.tabs.list'),
    '/dash/domains/servicemonitor': t('domains.tabs.servicemonitor'),
    '/dash/domains/ns-monitor': t('domains.tabs.nsMonitor'),
    '/dash/domains/renewal': t('domains.tabs.renewal'),
    '/dash/tunnels': t('tunnels.title'),
    '/dash/tokens': t('common.tokens'),
    '/dash/teams': t('common.teams'),
    '/dash/settings': t('common.settings'),
    '/dash/security': t('common.security'),
    '/dash/about': t('common.about'),
    '/dash/users': t('common.users'),
    '/dash/audit': t('common.audit'),
    '/dash/system': t('system.tabs.overview'),
    '/dash/system/database': t('system.tabs.database'),
    '/dash/system/security': t('system.tabs.security'),
    '/dash/system/access': t('system.tabs.access'),
    '/dash/system/network': t('system.tabs.network'),
    '/dash/system/notifications': t('system.tabs.notifications'),
    '/dash/system/workflow': t('system.tabs.workflow'),
  };
  const pageKey = segments.length ? segments[segments.length - 1] : '';
  const pageTitle = pageTitleMap[normalizedPath]
    ?? (/^\/dash\/domains\/[^/]+\/records$/.test(normalizedPath) ? t('common.records') : undefined)
    ?? pageKey
    ?? t('common.dashboard');
  const ThemeIcon = theme === 'light' ? ModeLightIcon : theme === 'dark' ? ModeDarkIcon : DesktopIcon;
  const nextTheme = theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto';
  const repoUrl = 'https://github.com/HiPM-Tech/DNSMgr';

  const searchItems = useMemo<HeaderSearchItem[]>(() => {
    const items: HeaderSearchItem[] = [
      { title: t('common.dashboard'), group: t('common.dashboard'), path: '/dash', keywords: ['dashboard', 'home', '首页', '仪表盘', '看板', '总览'] },
      { title: t('common.dnsAccounts'), group: t('common.dashboard'), path: '/dash/accounts', keywords: ['dns', 'account', 'provider', '账号', '服务商', '凭据'] },
      { title: t('domains.tabs.list'), group: t('common.domains'), path: '/dash/domains', keywords: ['domain', 'list', '域名', '列表', '解析记录'] },
      { title: t('domains.tabs.servicemonitor'), group: t('common.domains'), path: '/dash/domains/servicemonitor', keywords: ['service', 'monitor', 'ssl', 'endpoint', 'failover', '服务', '监控', '证书', '故障'] },
      { title: t('domains.tabs.nsMonitor'), group: t('common.domains'), path: '/dash/domains/ns-monitor', keywords: ['ns', 'monitor', 'nameserver', '监测', '污染', '劫持'] },
      { title: t('domains.tabs.renewal'), group: t('common.domains'), path: '/dash/domains/renewal', keywords: ['renewal', 'whois', '续期', '过期', '到期'] },
      { title: t('common.teams'), group: t('common.dashboard'), path: '/dash/teams', keywords: ['team', 'member', 'permission', '团队', '成员', '权限'] },
      { title: t('common.tokens'), group: t('common.dashboard'), path: '/dash/tokens', keywords: ['api', 'token', 'key', '令牌', '密钥'] },
      { title: t('settings.profileTitle'), group: t('common.settings'), path: '/dash/settings', keywords: ['profile', 'user', '个人资料', '昵称', '邮箱'] },
      { title: t('settings.avatarImageUrl'), group: t('common.settings'), path: '/dash/settings', keywords: ['avatar', '头像', '图片'] },
      { title: t('settings.changePassword'), group: t('common.settings'), path: '/dash/settings', keywords: ['password', '密码', '修改密码'] },
      { title: t('settings.backgroundImage'), group: t('common.settings'), path: '/dash/settings', keywords: ['background', 'wallpaper', '背景', '背景图'] },
      { title: t('settings.oauthBindingTitle'), group: t('common.settings'), path: '/dash/settings', keywords: ['oauth', 'logto', 'oidc', '绑定', '第三方登录'] },
      { title: t('common.security'), group: t('common.account'), path: '/dash/security', keywords: ['2fa', 'totp', 'webauthn', '安全', '双因素', '会话'] },
      { title: t('common.about'), group: t('common.account'), path: '/dash/about', keywords: ['about', 'version', 'license', '关于', '版本', '开源'] },
    ];

    if (showTunnels) {
      items.push({ title: t('tunnels.title'), group: t('common.dashboard'), path: '/dash/tunnels', keywords: ['tunnel', 'cloudflare', '隧道'] });
    }

    if (isAdmin) {
      items.push(
        { title: t('common.users'), group: t('common.admin'), path: '/dash/users', keywords: ['user', 'role', '用户', '角色', '管理员'] },
        { title: t('common.audit'), group: t('common.admin'), path: '/dash/audit', keywords: ['audit', 'log', '审计', '日志', '操作'] },
        { title: t('system.tabs.overview'), group: t('common.system'), path: '/dash/system', keywords: ['system', 'overview', '系统', '概览'] },
        { title: t('system.tabs.database'), group: t('common.system'), path: '/dash/system/database', keywords: ['database', 'sqlite', 'mysql', 'postgresql', '数据库'] },
        { title: t('system.tabs.security'), group: t('common.system'), path: '/dash/system/security', keywords: ['security policy', '2fa', 'login', '安全策略', '登录'] },
        { title: t('system.tabs.access'), group: t('common.system'), path: '/dash/system/access', keywords: ['access', 'oauth', 'logto', 'smtp', '访问', '登录方式'] },
        { title: t('system.tabs.network'), group: t('common.system'), path: '/dash/system/network', keywords: ['network', 'proxy', '网络', '代理'] },
        { title: t('system.tabs.notifications'), group: t('common.system'), path: '/dash/system/notifications', keywords: ['notification', 'smtp', 'email', '通知', '邮件'] },
      );
    }

    return items;
  }, [isAdmin, showTunnels, t]);

  const filteredSearchItems = useMemo(() => {
    const query = searchValue.trim().toLowerCase();
    if (!query) return searchItems.slice(0, 7);

    return searchItems
      .filter((item) => [item.title, item.group, item.path, ...item.keywords].join(' ').toLowerCase().includes(query))
      .slice(0, 8);
  }, [searchItems, searchValue]);

  useEffect(() => () => {
    if (searchBlurTimerRef.current) window.clearTimeout(searchBlurTimerRef.current);
    if (searchCloseTimerRef.current) window.clearTimeout(searchCloseTimerRef.current);
  }, []);

  const userOptions: DropdownOption[] = [
    { content: t('common.settings'), value: 'settings', prefixIcon: <SettingIcon /> },
    { content: t('common.security'), value: 'security', prefixIcon: <UserCircleIcon /> },
    { content: t('common.logout'), value: 'logout', prefixIcon: <LogoutIcon />, divider: true },
  ];

  const languageOptions = useMemo<DropdownOption[]>(() => localeOptions.map((option) => ({
    content: option.label,
    value: option.code,
    active: option.code === locale,
    prefixIcon: option.code === locale ? <CheckIcon /> : <span className="app-header__language-placeholder" />,
  })), [locale]);

  const handleUserAction = (option: DropdownOption) => {
    if (option.value === 'settings') {
      navigate('/dash/settings');
      return;
    }

    if (option.value === 'security') {
      navigate('/dash/security');
      return;
    }

    if (option.value === 'logout') {
      setShowLogoutConfirm(true);
    }
  };

  const handleConfirmLogout = () => {
    setShowLogoutConfirm(false);
    logout();
    navigate('/login');
  };

  const handleSearchNavigate = (item: HeaderSearchItem) => {
    navigate(item.path);
    setSearchValue('');
    closeSearchPanel();
  };

  const handleSearchEnter = () => {
    const [firstItem] = filteredSearchItems;
    if (firstItem) handleSearchNavigate(firstItem);
  };

  const openSearchPanel = () => {
    if (searchBlurTimerRef.current) window.clearTimeout(searchBlurTimerRef.current);
    if (searchCloseTimerRef.current) window.clearTimeout(searchCloseTimerRef.current);
    setSearchPanelMounted(true);
    setSearchPanelClosing(false);
    setSearchFocused(true);
  };

  const closeSearchPanel = () => {
    if (searchBlurTimerRef.current) window.clearTimeout(searchBlurTimerRef.current);
    if (searchCloseTimerRef.current) window.clearTimeout(searchCloseTimerRef.current);
    setSearchFocused(false);
    setSearchPanelClosing(true);
    searchCloseTimerRef.current = window.setTimeout(() => {
      setSearchPanelMounted(false);
      setSearchPanelClosing(false);
    }, 170);
  };

  return (
    <>
      <TLayout.Header className="app-header">
        <div className="app-header__left">
          <Button
            className="app-header__mobile-menu"
            shape="square"
            variant="text"
            size="large"
            icon={<ViewListIcon />}
            onClick={onMenuClick}
          />
          <Button
            className="app-header__collapse"
            shape="square"
            variant="text"
            size="large"
            icon={<ViewListIcon />}
            onClick={onToggleCollapse}
            title={collapsed ? t('common.expand') || 'Expand' : t('common.collapse') || 'Collapse'}
          />
          <div className="app-header__title-wrap">
            <h1 className="app-header__title">{pageTitle}</h1>
          </div>
        </div>

        <div className="app-header__right">
          <div className="app-header__search">
            <Input
              clearable
              type="search"
              name="hidns-global-search"
              autocomplete="off"
              value={searchValue}
              prefixIcon={<SearchIcon />}
              placeholder={t('common.globalSearchPlaceholder')}
              onChange={(value) => setSearchValue(String(value))}
              onFocus={openSearchPanel}
              onBlur={() => {
                searchBlurTimerRef.current = window.setTimeout(closeSearchPanel, 120);
              }}
              onEnter={handleSearchEnter}
              onKeydown={(_, context) => {
                if (context.e.key === 'Escape') {
                  closeSearchPanel();
                }
              }}
            />
            {searchPanelMounted && (
              <div
                className={`app-header__search-panel${searchFocused && !searchPanelClosing ? ' is-open' : ' is-closing'}`}
                role="listbox"
              >
                {filteredSearchItems.length > 0 ? (
                  filteredSearchItems.map((item) => (
                    <button
                      key={item.path + item.title}
                      type="button"
                      className="app-header__search-item"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => handleSearchNavigate(item)}
                    >
                      <span className="app-header__search-item-title">{item.title}</span>
                      <span className="app-header__search-item-group">{item.group}</span>
                    </button>
                  ))
                ) : (
                  <div className="app-header__search-empty">{t('common.searchNoResult')}</div>
                )}
              </div>
            )}
          </div>

          <Space align="center" size="small" className="app-header__actions">
            <Popup content="GitHub" placement="bottom" showArrow destroyOnClose>
              <Button
                shape="square"
                variant="text"
                size="large"
                icon={<LogoGithubIcon />}
                onClick={() => window.open(repoUrl, '_blank', 'noopener,noreferrer')}
              />
            </Popup>
            <Dropdown
              trigger="click"
              placement="bottom-right"
              options={languageOptions}
              maxHeight={320}
              minColumnWidth={168}
              maxColumnWidth={220}
              popupProps={{ overlayClassName: 'app-header__language-menu' }}
              onClick={(option) => setLocale(String(option.value))}
            >
              <Button
                shape="square"
                variant="text"
                size="large"
                icon={<TranslateIcon />}
                title={t('settings.language')}
              />
            </Dropdown>
            <Popup content={theme === 'auto' ? `Auto · ${resolvedTheme === 'dark' ? 'Dark' : 'Light'}` : theme === 'light' ? 'Light' : 'Dark'} placement="bottom" showArrow destroyOnClose>
              <Button
                shape="square"
                variant="text"
                size="large"
                icon={<ThemeIcon />}
                onClick={() => setTheme(nextTheme)}
              />
            </Popup>
            <Dropdown trigger="click" placement="bottom-right" options={userOptions} onClick={handleUserAction}>
              <Button variant="text" className="app-header__user">
                <Avatar username={displayName} email={user?.email} image={avatarImage} size={28} />
                <span className="app-header__user-name">{displayName}</span>
                <ChevronDownIcon />
              </Button>
            </Dropdown>
          </Space>
        </div>
      </TLayout.Header>

      {showLogoutConfirm && (
        <ConfirmDialog
          message={t('common.logoutConfirm')}
          confirmLabel={t('common.logout')}
          onConfirm={handleConfirmLogout}
          onCancel={() => setShowLogoutConfirm(false)}
        />
      )}
    </>
  );
}
