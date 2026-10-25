
import { connect, disconnect } from '/workspace/HiDNS/server/src/db/dal/connection';
import { initializeDSM } from '/workspace/HiDNS/server/src/db/dsm/init-dsm';
import { UserOperations, DnsAccountOperations, DomainOperations } from '/workspace/HiDNS/server/src/db/bal/business-adapter';

await connect();
await initializeDSM();
const uid = await UserOperations.create({ username: 'b6', nickname: 'b', email: 'b@t.co', password_hash: 'x', role: 'admin', role_level: 3 });
const aid = Number(await DnsAccountOperations.create({ type: 'virtual', name: 'acc', config: '{}', remark: '', created_by: Number(uid) }));

// 复刻 routes/domains.ts:884-929 的循环：逐条 getByAccountIdAndName → create，无事务
const items = [
  { name: 'ok-1.test', third_id: '', record_count: 0, remark: '' },
  { name: 'ok-2.test', third_id: '', record_count: 0, remark: '' },
];
let added = 0;
try {
  for (const [i, item] of items.entries()) {
    const accountId = i === 1 ? 999999 : aid;   // 第二项注入「账号已被并发删除」导致的 FK 失败
    const existing = await DomainOperations.getByAccountIdAndName(accountId, item.name);
    if (existing) continue;
    await DomainOperations.create({ account_id: accountId, name: item.name, third_id: '', record_count: 0, remark: '' });
    added++;
  }
} catch (e: any) {
  console.log('循环第 2 项抛出:', e.message, '→ 路由会 return 500（asyncHandler → errorHandler）');
}
const rows = await DomainOperations.getByAccountIdAndName(aid, 'ok-1.test');
console.log('added(局部计数) =', added, '| 库中已提交的域名 =', rows ? 'ok-1.test 存在' : '无');
const all = await DomainOperations.getAllForSuperAdmin();
console.log('domains 表行数 =', (all as unknown as any[]).length);
await disconnect();
process.exit(0);
