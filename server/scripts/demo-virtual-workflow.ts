/**
 * 虚拟 DNS 提供商 · 完整模拟演示（无需数据库、无需任何真实凭证）
 *
 * 运行：pnpm --filter dnsmgr-server demo:virtual
 *
 * 演示内容：
 *   1. 虚拟站点与解析记录
 *   2. 同一个域名被多个源站组引用
 *   3. DDNS 改动 A / AAAA 后，按地址族同步这些源站组
 *   4. 另一地址族、域名型源站、未被引用的组，全部保持原样
 */

import { createHash } from 'node:crypto';
import { VirtualAdapter } from '../src/lib/dns/providers/virtual/adapter';
import { VirtualStore } from '../src/lib/dns/providers/virtual/store';
import {
  applySyncSet,
  planSyncSet,
  selectGroupsForDomain,
} from '../src/lib/dns/origin-group-sync';

const DOMAIN = 'example.test';
const ZONE = 'virtual-zone-1';
const NEXT_V4 = '203.0.113.20';
const NEXT_V6 = '2001:db8::20';

function line(label: string, value: string): void {
  console.log('  ' + label.padEnd(12) + ' ' + value);
}

/** 摘要是 JSON 串，直接打印没有可读性；这里只取短指纹 */
function shortDigest(digest: string): string {
  return createHash('sha256').update(digest).digest('hex').slice(0, 16);
}

async function show(title: string, adapter: VirtualAdapter): Promise<void> {
  console.log('\n' + title);
  const records = await adapter.getDomainRecords(1, 100);
  line('解析记录', records.list.map((r) => `${r.Name}/${r.Type}=${r.Value}`).join('  '));
  const groups = await adapter.originGroups().list({ limit: 100 });
  for (const group of groups) {
    const refs = group.references.map((r) => r.name ?? r.id).join(', ') || '(无引用)';
    line(group.name, `[${group.records.map((r) => r.record).join(', ')}]  引用方: ${refs}`);
  }
}

async function main(): Promise<void> {
  VirtualStore.resetMemoryCache();
  const adapter = new VirtualAdapter({
    virtual_enabled: 'true',
    virtual_state: 'memory',
    virtual_seed: 'demo',
    virtual_tenant: 'demo',
    domain: DOMAIN,
    zoneId: ZONE,
  });

  if (!(await adapter.check())) {
    console.error('虚拟提供商未启用：' + adapter.getError());
    process.exit(1);
  }

  await show('【初始状态】', adapter);

  const groups = await adapter.originGroups().list({ limit: 100 });
  const targets = selectGroupsForDomain(groups, DOMAIN);
  console.log(`\n域名 ${DOMAIN} 被 ${targets.length} 个源站组引用: ${targets.map((g) => g.name).join(', ')}`);

  console.log('\n【模拟 DDNS】更新 A 与 AAAA 记录');
  for (const record of (await adapter.getDomainRecords(1, 100)).list) {
    if (record.Name !== '@') continue;
    if (record.Type === 'A') await adapter.updateDomainRecord(record.RecordId, record.Name, 'A', NEXT_V4);
    if (record.Type === 'AAAA') await adapter.updateDomainRecord(record.RecordId, record.Name, 'AAAA', NEXT_V6);
  }

  const ops = adapter.originGroups();
  const request = {
    groupIds: targets.map((g) => g.groupId),
    update: { v4: NEXT_V4, v6: NEXT_V6 },
    options: { addIfMissing: true },
  };

  const plan = await planSyncSet(ops, request);
  console.log('\n【同步计划】');
  for (const p of plan.plans) {
    const changes = p.changes.map((c) => `${c.family}: ${c.from.join(',') || '(无)'} → ${c.to}`).join('; ');
    line(p.name, changes || '(无改动)');
  }
  console.log('  摘要 ' + shortDigest(plan.digest));

  const { results } = await applySyncSet(ops, request, plan.digest);
  console.log('\n【执行结果】');
  for (const result of results) {
    line(result.groupId, `${result.status}  requestId=${result.requestId ?? '-'}`);
  }

  await show('【最终状态】', adapter);
  console.log('\n演示结束：未被引用的组与域名型源站未发生任何变化。');
}

main().catch((error) => {
  console.error('演示失败:', error);
  process.exit(1);
});
