import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAllEnabled: vi.fn(),
  getStatus: vi.fn(),
  runCheckAndUpdate: vi.fn(),
  submit: vi.fn(),
  getSuperAdminUserIds: vi.fn(),
  connect: vi.fn(),
}));

vi.mock('../db/bal/business-adapter', () => ({
  ServiceMonitorOperations: { getStatus: mocks.getStatus },
  getDbType: () => 'sqlite',
}));
vi.mock('./serviceMonitor', () => ({
  getAllEnabled: mocks.getAllEnabled,
  runCheckAndUpdate: mocks.runCheckAndUpdate,
}));
vi.mock('./taskManager', () => ({
  taskManager: { submit: (config: unknown, task: () => Promise<void>) => mocks.submit(config, task) },
}));
vi.mock('./realtime-audience', () => ({ getSuperAdminUserIds: mocks.getSuperAdminUserIds }));
vi.mock('../db/dal/connection', () => ({ connect: mocks.connect }));

import { wsService } from './websocket';
import { startServiceMonitorJob } from './serviceMonitorJob';

const CHECK_CYCLE_MS = 5 * 60 * 1000;

function monitor(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    userId: 42,
    name: 'endpoint',
    type: 'endpoint',
    target: 'https://example.com',
    domainId: null,
    parentId: null,
    config: {},
    checkInterval: 60,
    checkTimeout: 30,
    enabled: true,
    notifyOnFailure: true,
    notifyOnRecovery: true,
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.submit.mockImplementation(async (_config: unknown, task: () => Promise<void>) => task());
  mocks.runCheckAndUpdate.mockResolvedValue(undefined);
  mocks.getStatus.mockResolvedValue({ last_check_at: null });
  mocks.getSuperAdminUserIds.mockResolvedValue([1]);
  vi.spyOn(wsService, 'broadcastToUsers').mockImplementation(() => 1);
  vi.spyOn(wsService, 'broadcast').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('服务监控检查结果的推送范围', () => {
  it('只推给监控所有者与超管，不再全局广播', async () => {
    mocks.getAllEnabled.mockResolvedValue([monitor()]);
    vi.useFakeTimers();

    startServiceMonitorJob();
    await vi.advanceTimersByTimeAsync(CHECK_CYCLE_MS);

    expect(mocks.runCheckAndUpdate).toHaveBeenCalledTimes(1);
    expect(wsService.broadcastToUsers).toHaveBeenCalledWith(
      [42, 1],
      expect.objectContaining({
        type: 'servicemonitor_checked',
        data: { id: 5, userId: 42 },
      }),
    );
    // 回归闸门：他人监控 id 与所属用户 id 不得推给所有在线客户端
    expect(wsService.broadcast).not.toHaveBeenCalled();
  });

  it('多个用户的监控各推给自己的所有者', async () => {
    mocks.getAllEnabled.mockResolvedValue([
      monitor({ id: 5, userId: 42 }),
      monitor({ id: 6, userId: 43 }),
    ]);
    mocks.getSuperAdminUserIds.mockResolvedValue([]);
    vi.useFakeTimers();

    startServiceMonitorJob();
    await vi.advanceTimersByTimeAsync(CHECK_CYCLE_MS);

    const recipients = (wsService.broadcastToUsers as never as { mock: { calls: unknown[][] } }).mock.calls.map(
      (call) => call[0],
    );
    expect(recipients).toEqual([[42], [43]]);
    expect(wsService.broadcast).not.toHaveBeenCalled();
  });

  it('未到检查时间不发推送', async () => {
    mocks.getAllEnabled.mockResolvedValue([monitor({ checkInterval: 3600 })]);
    mocks.getStatus.mockResolvedValue({ last_check_at: new Date().toISOString() });
    vi.useFakeTimers();

    startServiceMonitorJob();
    await vi.advanceTimersByTimeAsync(CHECK_CYCLE_MS);

    expect(mocks.runCheckAndUpdate).not.toHaveBeenCalled();
    expect(wsService.broadcastToUsers).not.toHaveBeenCalled();
  });
});
