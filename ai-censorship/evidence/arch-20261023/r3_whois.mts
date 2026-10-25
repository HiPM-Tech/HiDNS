
import { connect, disconnect } from '/workspace/HiDNS/server/src/db/dal/connection';
import { initializeDSM } from '/workspace/HiDNS/server/src/db/dsm/init-dsm';
import { WhoisOperations, UserOperations, DnsAccountOperations, DomainOperations } from '/workspace/HiDNS/server/src/db/bal/business-adapter';

await connect();
await initializeDSM();
const uid = await UserOperations.create({ username: 'whoisuser', nickname: 'w', email: 'w@t.co', password_hash: 'x', role: 'admin', role_level: 3 });
const aid = await DnsAccountOperations.create({ type: 'virtual', name: 'acc', config: '{}', remark: '', created_by: Number(uid) });
for (let i = 1; i <= 250; i++) {
  await DomainOperations.create({ account_id: Number(aid), name: 'd' + String(i).padStart(3, '0') + '.test', third_id: '', record_count: 0, remark: '' });
}
const all1 = await WhoisOperations.getAllDomains() as any[];
const all2 = await WhoisOperations.getAllDomains() as any[];
const ids1 = all1.map((d) => d.id);
const ids2 = all2.map((d) => d.id);
const LIMIT = Number(process.env.WHOIS_BATCH_LIMIT ?? 200) || 200;
const batch1 = ids1.slice(0, LIMIT);
const batch2 = ids2.slice(0, LIMIT);
console.log('域名总数 =', all1.length, '| 每轮下限 =', LIMIT);
console.log('两次 getAllDomains 顺序完全一致 =', JSON.stringify(ids1) === JSON.stringify(ids2));
console.log('两次 batch(0..200) 完全一致 =', JSON.stringify(batch1) === JSON.stringify(batch2));
console.log('batch 覆盖 id 范围 =', batch1[0], '..', batch1[batch1.length - 1]);
console.log('未进入任何一轮的域名数 =', ids1.length - new Set(batch1).size, '| 例:', ids1.slice(LIMIT, LIMIT + 3));
await disconnect();
process.exit(0);
