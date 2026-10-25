
import { connect, disconnect } from '/workspace/HiDNS/server/src/db/dal/connection';
import { initializeDSM } from '/workspace/HiDNS/server/src/db/dsm/init-dsm';
import { TeamOperations, UserOperations } from '/workspace/HiDNS/server/src/db/bal/business-adapter';

await connect();
await initializeDSM();
const uid = await UserOperations.create({ username: 'seed', nickname: 'seed', email: 's@t.co', password_hash: 'x', role: 'admin', role_level: 3 });
console.log('seed user id =', uid);

// 复刻 routes/teams.ts:167-172 的写序列：create → addMember（无事务）
let teamId: number | null = null;
try {
  teamId = await TeamOperations.create({ name: 'audit-team', description: '', created_by: Number(uid) });
  console.log('step1 TeamOperations.create -> id =', teamId);
  await TeamOperations.addMember(teamId, 999999, 'admin');       // 触发外键失败
  console.log('step2 addMember ok');
} catch (e: any) {
  console.log('step2 addMember FAILED:', e.message);
}
const row = await TeamOperations.getById(teamId as number);
const members = await TeamOperations.getMembers(teamId as number);
console.log('after-failure: 团队行仍在 =', !!row, '成员数 =', members.length);
await disconnect();
process.exit(0);
