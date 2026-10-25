import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENT_QUERY_MAP, RealtimeProvider, useRealtimeStatus } from '../realtime';

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  close() { this.closed = true; }
  emit(payload: unknown) { this.onmessage?.({ data: JSON.stringify(payload) }); }
}

function Probe() {
  const status = useRealtimeStatus();
  return <span data-testid="status">{status}</span>;
}

function setup() {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined as never);
  render(
    <QueryClientProvider client={client}>
      <RealtimeProvider url="ws://test/api/socket/ws">
        <Probe />
      </RealtimeProvider>
    </QueryClientProvider>,
  );
  return { invalidate };
}

describe('RealtimeProvider', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  });

  it('整个应用只建立一条连接，并上报在线状态', () => {
    setup();
    expect(FakeSocket.instances).toHaveLength(1);
    act(() => { FakeSocket.instances[0].onopen?.(); });
    expect(screen.getByTestId('status').textContent).toBe('online');
  });

  it('按事件映射失效对应查询，未知事件忽略', () => {
    const { invalidate } = setup();
    const socket = FakeSocket.instances[0];

    act(() => { socket.emit({ type: 'token_created' }); });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tokens'] });

    invalidate.mockClear();
    act(() => { socket.emit({ type: 'team_member_added' }); });
    expect(invalidate.mock.calls.map((call) => (call[0] as { queryKey: string[] }).queryKey)).toEqual([
      ['teams'],
      ['team-members'],
    ]);

    invalidate.mockClear();
    act(() => { socket.emit({ type: 'unknown_event' }); });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('连接关闭后标记离线', () => {
    setup();
    const socket = FakeSocket.instances[0];
    act(() => { socket.onopen?.(); });
    act(() => { socket.onclose?.(); });
    expect(screen.getByTestId('status').textContent).toBe('offline');
  });

  it('映射表覆盖后端已推送的关键事件', () => {
    for (const type of [
      'token_created', 'token_revoked', 'team_member_added', 'user_updated',
      'domain_renewed', 'record_updated', 'account_created', 'audit_log_created',
      'servicemonitor_checked', 'ns_monitor_updated', 'user_created', 'smtp_updated',
    ]) {
      expect(EVENT_QUERY_MAP[type], type).toBeDefined();
    }
  });
});
