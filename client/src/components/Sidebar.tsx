import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Drawer, Menu } from 'tdesign-react';
import type { MenuValue } from 'tdesign-react';
import {
  DashboardIcon,
  ActivityIcon,
  CalendarIcon,
  DataBaseIcon,
  FileSearchIcon,
  InfoCircleIcon,
  InternetIcon,
  KeyIcon,
  LinkIcon,
  NotificationIcon,
  RootListIcon,
  SecuredIcon,
  LockOnIcon,
  ServerIcon,
  SettingIcon,
  SystemSettingIcon,
  UserSettingIcon,
  UsergroupIcon,
} from 'tdesign-icons-react';
import { useAuth } from '../contexts/AuthContext';
import { useI18n } from '../contexts/I18nContext';
import { useTheme } from '../contexts/ThemeContext';
import { useLocalStorage } from '../hooks/useLocalStorage';
import './Sidebar.css';

const { MenuItem, MenuGroup, SubMenu } = Menu;

interface NavItem {
  to: string;
  icon: ReactElement;
  key: string;
  end?: boolean;
}

const primaryItems: NavItem[] = [
  { to: '/dash', icon: <DashboardIcon />, key: 'common.dashboard', end: true },
  { to: '/dash/accounts', icon: <ServerIcon />, key: 'common.dnsAccounts' },
  { to: '/dash/teams', icon: <UsergroupIcon />, key: 'common.teams' },
  { to: '/dash/tokens', icon: <KeyIcon />, key: 'common.tokens' },
];

const domainItems: NavItem[] = [
  { to: '/dash/domains', icon: <RootListIcon />, key: 'domains.tabs.list' },
  { to: '/dash/domains/servicemonitor', icon: <ActivityIcon />, key: 'domains.tabs.servicemonitor' },
  { to: '/dash/domains/ns-monitor', icon: <SecuredIcon />, key: 'domains.tabs.nsMonitor' },
  { to: '/dash/domains/renewal', icon: <CalendarIcon />, key: 'domains.tabs.renewal' },
];

const adminItems: NavItem[] = [
  { to: '/dash/users', icon: <UserSettingIcon />, key: 'common.users' },
  { to: '/dash/audit', icon: <FileSearchIcon />, key: 'common.audit' },
  { to: '/dash/workflows', icon: <LinkIcon />, key: 'workflows.title' },
];

const systemItems: NavItem[] = [
  { to: '/dash/system', icon: <InfoCircleIcon />, key: 'system.tabs.overview' },
  { to: '/dash/system/database', icon: <DataBaseIcon />, key: 'system.tabs.database' },
  { to: '/dash/system/security', icon: <SecuredIcon />, key: 'system.tabs.security' },
  { to: '/dash/system/access', icon: <KeyIcon />, key: 'system.tabs.access' },
  { to: '/dash/system/network', icon: <InternetIcon />, key: 'system.tabs.network' },
  { to: '/dash/system/notifications', icon: <NotificationIcon />, key: 'system.tabs.notifications' },
  { to: '/dash/system/workflow', icon: <LinkIcon />, key: 'system.tabs.workflow' },
];

const accountItems: NavItem[] = [
  { to: '/dash/mcp', icon: <SystemSettingIcon />, key: 'common.mcp' },
  { to: '/dash/settings', icon: <SettingIcon />, key: 'common.settings' },
  { to: '/dash/security', icon: <LockOnIcon />, key: 'common.security' },
  { to: '/dash/about', icon: <InfoCircleIcon />, key: 'common.about' },
];

function getActivePath(pathname: string, menuItems: NavItem[]) {
  const match = [...menuItems]
    .sort((a, b) => b.to.length - a.to.length)
    .find((item) => (item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`)));

  return match?.to ?? '/';
}

interface AppMenuProps {
  collapsed: boolean;
  onClose?: () => void;
}

function AppMenu({ collapsed, onClose }: AppMenuProps) {
  const { isAdmin } = useAuth();
  const { t } = useI18n();
  const { isDark } = useTheme();
  const [showTunnels] = useLocalStorage('showTunnels', false);
  const navigate = useNavigate();
  const location = useLocation();
  const [expanded, setExpanded] = useState<MenuValue[]>(
    [
      ...(location.pathname.startsWith('/dash/domains') ? ['/domains-group'] : []),
      ...(location.pathname.startsWith('/dash/system') ? ['/system-group'] : []),
    ],
  );

  const menuItems = useMemo(() => {
    const items = [...primaryItems];
    if (showTunnels) {
      items.push({ to: '/dash/tunnels', icon: <LinkIcon />, key: 'tunnels.title' });
    }
    return [...items, ...domainItems, ...(isAdmin ? [...adminItems, ...systemItems] : []), ...accountItems];
  }, [isAdmin, showTunnels]);

  const activePath = getActivePath(location.pathname, menuItems);
  const isDomainGroupActive = collapsed && location.pathname.startsWith('/dash/domains');
  const isSystemGroupActive = collapsed && location.pathname.startsWith('/dash/system');
  const menuValue = isDomainGroupActive
    ? '/domains-group'
    : isSystemGroupActive
      ? '/system-group'
      : activePath;

  useEffect(() => {
    if (location.pathname.startsWith('/dash/domains')) {
      setExpanded((current) => (current.includes('/domains-group') ? current : [...current, '/domains-group']));
    }
    if (location.pathname.startsWith('/dash/system')) {
      setExpanded((current) => (current.includes('/system-group') ? current : [...current, '/system-group']));
    }
  }, [location.pathname]);

  const handleChange = (value: MenuValue) => {
    const target = String(value);
    if (target === '/domains-group' || target === '/system-group') return;
    navigate(target);
    onClose?.();
  };

  const renderItems = (items: NavItem[]) => items.map((item) => (
    <MenuItem key={item.to} value={item.to} icon={item.icon}>
      {t(item.key)}
    </MenuItem>
  ));

  return (
    <Menu
      width={['232px', '72px']}
      className="app-sidebar__menu"
      value={menuValue}
      expanded={expanded}
      collapsed={collapsed}
      theme={isDark ? 'dark' : 'light'}
      onChange={handleChange}
      onExpand={(value) => setExpanded(value)}
    >
      <MenuGroup title={!collapsed ? t('common.dashboard') : undefined}>
        {renderItems(primaryItems.slice(0, 2))}
        <SubMenu
          className={`app-sidebar__plain-submenu ${isDomainGroupActive ? 'app-sidebar__plain-submenu--active' : ''}`}
          value="/domains-group"
          title={t('common.domains')}
          icon={<InternetIcon />}
        >
          {renderItems(domainItems)}
        </SubMenu>
        {renderItems(primaryItems.slice(2))}
        {showTunnels && (
          <MenuItem value="/tunnels" icon={<LinkIcon />}>
            {t('tunnels.title')}
          </MenuItem>
        )}
      </MenuGroup>

      {isAdmin && (
        <MenuGroup title={!collapsed ? t('common.admin') : undefined}>
          {renderItems(adminItems)}
          <SubMenu
            className={`app-sidebar__plain-submenu ${isSystemGroupActive ? 'app-sidebar__plain-submenu--active' : ''}`}
            value="/system-group"
            title={t('common.system')}
            icon={<SystemSettingIcon />}
          >
            {renderItems(systemItems)}
          </SubMenu>
        </MenuGroup>
      )}

      <MenuGroup title={!collapsed ? t('common.account') : undefined}>
        {renderItems(accountItems)}
      </MenuGroup>
    </Menu>
  );
}

interface SidebarProps {
  collapsed: boolean;
  onCollapseChange?: (collapsed: boolean) => void;
  isMobile?: boolean;
  visible?: boolean;
  onClose?: () => void;
}

export function Sidebar({ collapsed, isMobile = false, visible = false, onClose }: SidebarProps) {
  if (isMobile) {
    return (
      <Drawer
        className="app-sidebar-drawer"
        visible={visible}
        placement="left"
        size="260px"
        header={false}
        footer={false}
        closeBtn={false}
        destroyOnClose
        onClose={onClose}
      >
        <AppMenu collapsed={false} onClose={onClose} />
      </Drawer>
    );
  }

  return (
    <aside className={`app-sidebar ${collapsed ? 'app-sidebar--collapsed' : ''}`}>
      <AppMenu collapsed={collapsed} />
    </aside>
  );
}
