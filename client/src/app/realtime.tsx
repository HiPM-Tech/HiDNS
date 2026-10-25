import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/**
 * 全局实时刷新（单连接）。
 *
 * 旧实现 `hooks/useRealtimeData` 是「每个页面各开一条 WebSocket」，页面上同时有 N 个
 * 实时区块就连 N 条，且各自解析一遍消息。这里改成：整个应用一条连接，
 * 事件 → queryKey 前缀的映射集中在一张表里，命中就失效对应查询。
 */

/**
 * 事件 → 需要失效的 queryKey 前缀（与各 feature 的 key 保持一致）。
 *
 * 故意不映射 `resource:snapshot`：前端目前没有资源面板（无消费方），
 * 后端已改为「无人连接时跳过采集与广播」，因此不存在漏刷新；
 * 若后续新增资源页，在这里加 `['resource-monitor']` 即可。
 */
export const EVENT_QUERY_MAP: Record<string, string[][]> = {
  token_created: [['tokens']],
  token_updated: [['tokens']],
  token_revoked: [['tokens']],

  team_created: [['teams']],
  team_updated: [['teams'], ['team-members']],
  team_deleted: [['teams']],
  team_member_added: [['teams'], ['team-members']],
  team_member_removed: [['teams'], ['team-members']],

  user_created: [['users']],
  user_updated: [['users'], ['session']],
  user_deleted: [['users']],

  // ['domain', id] 这类带参 key 用前缀失效：invalidateQueries 默认按前缀匹配
  domain_created: [['domains'], ['domain']],
  domain_updated: [['domains'], ['domain']],
  domain_deleted: [['domains'], ['domain']],
  domain_renewed: [['domains'], ['renewable-domains']],
  domain_whois_updated: [['domains']],
  pinned_domains_updated: [['domains']],

  record_created: [['records'], ['domain']],
  record_updated: [['records'], ['domain']],
  record_deleted: [['records'], ['domain']],
  record_status_changed: [['records'], ['domain']],

  account_created: [['accounts']],
  account_updated: [['accounts']],
  account_deleted: [['accounts']],

  audit_log_created: [['audit-logs']],

  servicemonitor_created: [['service-monitors']],
  servicemonitor_updated: [['service-monitors']],
  servicemonitor_deleted: [['service-monitors']],
  servicemonitor_checked: [['service-monitors']],

  ns_monitor_created: [['ns-monitors']],
  ns_monitor_updated: [['ns-monitors']],
  ns_monitor_deleted: [['ns-monitors']],
  ns_monitor_prefs_updated: [['ns-monitors']],


  smtp_updated: [['system-security']],
  oauth_updated: [['system-security']],
  security_config_updated: [['system-security']],
  config_updated: [['system-security'], ['system-info']],

  trusted_device_removed: [['security', 'devices']],
  '2fa_enabled': [['security'], ['session']],
  '2fa_disabled': [['security'], ['session']],
};

export type RealtimeStatus = 'connecting' | 'online' | 'offline';

interface RealtimeContextValue {
  status: RealtimeStatus;
}

const RealtimeContext = createContext<RealtimeContextValue>({ status: 'offline' });

export function useRealtimeStatus(): RealtimeStatus {
  return useContext(RealtimeContext).status;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export function RealtimeProvider({ children, url }: { children: ReactNode; url?: string }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<RealtimeStatus>('connecting');
  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposedRef = useRef(false);
  /** 服务端明确拒绝（连接数超限）后不再重连 */
  const rejectedRef = useRef(false);

  useEffect(() => {
    disposedRef.current = false;

    const resolveUrl = () => {
      if (url) return url;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${protocol}//${window.location.host}/api/socket/ws`;
    };

    const connect = () => {
      if (disposedRef.current || rejectedRef.current) return;
      setStatus((prev) => (prev === 'online' ? prev : 'connecting'));

      let socket: WebSocket;
      try {
        socket = new WebSocket(resolveUrl());
      } catch {
        scheduleReconnect();
        return;
      }
      socketRef.current = socket;

      socket.onopen = () => {
        const wasReconnect = retryRef.current > 0;
        retryRef.current = 0;
        setStatus('online');
        // 重连成功后补一次全量刷新：断线期间的事件已经丢了，
        // 只建连不刷新会让页面一直显示旧数据（C 端细节轮 P1）。
        if (wasReconnect) { void queryClient.invalidateQueries(); }
      };

      socket.onmessage = (event) => {
        let payload: { type?: string } | null = null;
        try {
          payload = JSON.parse(String(event.data)) as { type?: string };
        } catch {
          return;
        }
        const type = payload?.type;
        if (!type) return;
        const keys = EVENT_QUERY_MAP[type];
        if (!keys) return;
        for (const key of keys) void queryClient.invalidateQueries({ queryKey: key });
      };

      socket.onclose = (event) => {
        if (disposedRef.current) return;
        setStatus('offline');
        // 4005 = 服务端因「该账号连接数超限」主动拒绝。继续重连只会无限打服务端，
        // 这里停下并让页面走「手动刷新」路径（多开标签页的正常用户不会触发）。
        if (event?.code === 4005) {
          rejectedRef.current = true;
          return;
        }
        scheduleReconnect();
      };

      socket.onerror = () => {
        socket.close();
      };
    };

    const scheduleReconnect = () => {
      if (disposedRef.current) return;
      const attempt = retryRef.current++;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
      timerRef.current = setTimeout(connect, delay);
    };

    connect();

    return () => {
      disposedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      const socket = socketRef.current;
      if (socket) {
        // 先摘掉回调再关闭：React 严格模式下 effect 会「挂载→卸载→再挂载」，
        // 旧连接的 onclose 若在新一轮里触发，会被当成「意外掉线」→ 立刻重连 → 又触发旧连接关闭，
        // 形成每秒一次的连接抖动（界面上长期显示「实时已断开」）。
        socket.onclose = null;
        socket.onerror = null;
        socket.onmessage = null;
        socket.onopen = null;
        socket.close();
      }
      socketRef.current = null;
    };
  }, [queryClient, url]);

  const value = useMemo<RealtimeContextValue>(() => ({ status }), [status]);
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}
