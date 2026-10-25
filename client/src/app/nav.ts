import {
  Activity, BookOpen, CalendarClock, FileSearch, Gauge, KeyRound, LayoutGrid,
  Lock, Radar, Server, Settings, ShieldCheck, Users, UserCog, Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  adminOnly?: boolean;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

/** 导航配置（唯一来源；旧 Sidebar 的 i18n key 与 TDesign 图标不再使用） */
export const navGroups: NavGroup[] = [
  {
    title: '概览',
    items: [{ to: '/dash', label: '仪表盘', icon: Gauge, end: true }],
  },
  {
    title: '资源',
    items: [
      { to: '/dash/accounts', label: 'DNS 账户', icon: Server },
      { to: '/dash/domains', label: '域名', icon: LayoutGrid },
      { to: '/dash/domains/servicemonitor', label: '服务监控', icon: Activity },
      { to: '/dash/domains/ns-monitor', label: 'NS 监控', icon: Radar },
      { to: '/dash/domains/renewal', label: '域名续期', icon: CalendarClock },
    ],
  },
  {
    title: '协作',
    items: [
      { to: '/dash/teams', label: '团队', icon: Users },
      { to: '/dash/users', label: '用户', icon: UserCog, adminOnly: true },
      { to: '/dash/tokens', label: 'API 令牌', icon: KeyRound },
    ],
  },
  {
    title: '运维',
    items: [
      { to: '/dash/audit', label: '审计日志', icon: FileSearch, adminOnly: true },
      { to: '/dash/workflows', label: '自动化工作流', icon: Workflow, adminOnly: true },
    ],
  },
  {
    title: '系统',
    items: [
      { to: '/dash/settings', label: '设置', icon: Settings },
      { to: '/dash/security', label: '安全', icon: ShieldCheck },
      { to: '/dash/system', label: '系统管理', icon: Lock, adminOnly: true },
      { to: '/dash/mcp', label: 'MCP', icon: BookOpen },
      { to: '/dash/about', label: '关于', icon: BookOpen },
    ],
  },
];

/** 根据当前路径找标题（面包屑/顶栏用） */
export function findNavLabel(pathname: string): string {
  const all = navGroups.flatMap((group) => group.items);
  const matched = all
    .filter((item) => (item.end ? pathname === item.to : pathname.startsWith(item.to)))
    .sort((a, b) => b.to.length - a.to.length)[0];
  return matched?.label ?? '仪表盘';
}
