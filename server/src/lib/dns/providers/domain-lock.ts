/**
 * 按域名串行化「读-改-写」型写操作。
 *
 * 适用于上游是「全量保存」语义的提供商（Spaceship 的 PUT、Dynadot 的 set_dns2）：
 * read → modify → write 之间若插入另一个写，后写完的会覆盖先写完的（lost update）。
 *
 * 单实例内用模块级队列串行即可；多实例部署需要分布式锁，超出当前范围。
 */
const domainWriteQueues = new Map<string, Promise<unknown>>();

export function withDomainLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const k = (key || '__default__').toLowerCase();
  const prev = domainWriteQueues.get(k) ?? Promise.resolve();
  // 前一个任务无论成功失败都要继续执行下一个
  const run = prev.then(() => fn(), () => fn());
  const tail = run.then(() => undefined, () => undefined);
  domainWriteQueues.set(k, tail);
  void tail.finally(() => {
    // 只有自己还是队尾时才清理，避免把后来者的链丢掉
    if (domainWriteQueues.get(k) === tail) domainWriteQueues.delete(k);
  });
  return run;
}