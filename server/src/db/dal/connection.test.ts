import { describe, it, expect, vi } from 'vitest';
import { ConnectionManager } from './connection';

/**
 * 回归测试：事务必须归还连接。
 *
 * 真实故障现象：postgresql / mysql 驱动在 beginTransaction 里从连接池取出一个 client，
 * 但 ConnectionManager.transaction() 只发 COMMIT/ROLLBACK、从不 release，
 * 于是每次事务泄漏一个连接；池耗尽后所有查询挂起，disconnect() 里的 pool.end() 永不返回
 * （在 PostgreSQL 上表现为 test:error-recovery 的「断开后重连」步骤直接卡死）。
 */

function managerWith(trx: Record<string, unknown>) {
  const manager = ConnectionManager.getInstance();
  (manager as unknown as { connection: unknown }).connection = {
    beginTransaction: async () => trx,
  };
  return manager;
}

describe('ConnectionManager.transaction 连接归还', () => {
  it('成功路径要调用 done（归还连接）', async () => {
    const done = vi.fn();
    const trx = { execute: vi.fn(), done };
    const manager = managerWith(trx);

    await expect(manager.transaction(async () => 'ok')).resolves.toBe('ok');
    expect(trx.execute).toHaveBeenCalledWith('COMMIT');
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('业务抛错路径要 ROLLBACK 并且仍然归还连接', async () => {
    const done = vi.fn();
    const trx = { execute: vi.fn(), done };
    const manager = managerWith(trx);

    await expect(manager.transaction(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(trx.execute).toHaveBeenCalledWith('ROLLBACK');
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('COMMIT 本身失败也要归还连接', async () => {
    const done = vi.fn();
    const trx = { execute: vi.fn().mockRejectedValue(new Error('commit failed')), done };
    const manager = managerWith(trx);

    await expect(manager.transaction(async () => 'ok')).rejects.toThrow('commit failed');
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('驱动未实现 done 时不应报错（sqlite 等非池驱动）', async () => {
    const trx = { execute: vi.fn() };
    const manager = managerWith(trx);
    await expect(manager.transaction(async () => 1)).resolves.toBe(1);
  });
});
