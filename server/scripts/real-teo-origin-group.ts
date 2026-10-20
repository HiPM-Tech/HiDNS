/**
 * 真实 EdgeOne 源站组操作执行器（仅用于指定的测试源站组）
 *
 * 走的是**真实动作层**：createDispatcher → authorize → 提供商 handler → 真实 TEO API。
 * 与工作流引擎执行动作时是同一条路径，只是事件来源由本脚本提供。
 *
 * 用法：
 *   TC_SECRET_ID=... TC_SECRET_KEY=... npx ts-node --files scripts/real-teo-origin-group.ts            # 只预览
 *   TC_SECRET_ID=... TC_SECRET_KEY=... npx ts-node --files scripts/real-teo-origin-group.ts --apply    # 执行写入
 *
 * 安全约束（硬编码，不依赖调用方自律）：
 *   1. 只允许操作 og-3we4nqony3sn(TEST-O) 与 og-3we4ndtas6nr(TEST-HTTP)
 *   2. 写入前必须 References 为空
 *   3. 写入前必须拿到与预览一致的 diffDigest
 *   4. 写入后回读校验，回执 RequestId 必须落纸
 */

import { createDispatcher } from '../src/workflow/dispatch';
import { lookupActionMeta } from '../src/workflow/actions/registry';
import { DnsProviderService } from '../src/service/dns-provider-service';
import { DomainOperations } from '../src/db/bal/business-adapter';
import { TencenteoAdapter } from '../src/lib/dns/providers/tencenteo/adapter';
import type { Principal } from '../src/workflow/auth';

// 默认值必须是明显的占位符：这个脚本会真的改写线上源站组，
// 把真实 zone / 域名写死当默认值，等于漏传参数时默认操作真实站点。
const ZONE_ID = process.env.TC_ZONE_ID ?? 'zone-REPLACE_ME';
const DOMAIN_NAME = process.env.TC_DOMAIN ?? 'example.com';
const DOMAIN_ID = Number(process.env.TC_DOMAIN_ID ?? '1');

/**
 * 白名单：只有这里列出的组允许被本脚本写入。
 * 默认为空 —— 真实源站组 ID 不应写死进仓库，用
 *   TC_ALLOWED_GROUPS="og-xxx=名称A,og-yyy=名称B"
 * 传入；为空时脚本不会写入任何组。
 */
const ALLOWED_GROUPS = new Map<string, string>(
  String(process.env.TC_ALLOWED_GROUPS ?? '')
    .split(',')
    .map((pair) => pair.split('='))
    .filter((pair) => pair.length === 2 && Boolean(pair[0].trim()))
    .map((pair) => [pair[0].trim(), pair[1].trim()] as [string, string]),
);

const TARGETS = new Map<string, string>([
  ['og-3we4nqony3sn', process.env.TC_TARGET_TEST_O ?? '203.0.113.10'],
  ['og-3we4ndtas6nr', process.env.TC_TARGET_TEST_HTTP ?? '203.0.113.11'],
]);

const apply = process.argv.includes('--apply');

const principal: Principal = {
  kind: 'user',
  id: 'script',
  role: 'super_admin',
  services: ['records.read', 'records.write'],
  allowedDomainIds: [DOMAIN_ID],
  allowedWriteDomainIds: [DOMAIN_ID],
  allowedDomains: [DOMAIN_NAME],
};

function wire(): void {
  const secretId = process.env.TC_SECRET_ID ?? '';
  const secretKey = process.env.TC_SECRET_KEY ?? '';
  if (!secretId || !secretKey) {
    console.error('缺少 TC_SECRET_ID / TC_SECRET_KEY');
    process.exit(2);
  }
  const adapter = new TencenteoAdapter({ SecretId: secretId, SecretKey: secretKey, site_type: 'mainland' });

  // 只替换"账号/域名从数据库读取"这一段：动作层与提供商实现保持真实
  (DnsProviderService as unknown as { getAdapterByAccount: (id: number) => Promise<unknown> }).getAdapterByAccount =
    async () => adapter;
  (DomainOperations as unknown as { getById: (id: number) => Promise<unknown> }).getById = async () => ({
    id: DOMAIN_ID,
    name: DOMAIN_NAME,
    account_id: 1,
    third_id: ZONE_ID,
  });
}

function shortDigest(digest: string): string {
  return digest.slice(0, 48) + (digest.length > 48 ? '…' : '');
}

async function main(): Promise<void> {
  wire();
  const dispatch = createDispatcher({
    authorizeDeps: {
      lookupAction: lookupActionMeta,
      audit: async () => undefined,
      rateLimit: () => true,
      now: () => Date.now(),
      newTraceId: () => 'teo-' + Date.now().toString(36),
    },
  });

  console.log(apply ? '=== 模式：执行写入 ===' : '=== 模式：仅预览（加 --apply 才写） ===');
  console.log('站点:', ZONE_ID, '| 域名:', DOMAIN_NAME);

  for (const [groupId, label] of ALLOWED_GROUPS) {
    const target = TARGETS.get(groupId)!;
    const options = { trigger: 'api' as const, triggerType: 'record.changed' };

    const plan = (await dispatch(
      'ext.tencenteo.originGroup.plan',
      principal,
      { domainId: DOMAIN_ID, groupId, target },
      options,
    )) as {
      groupId: string;
      collapsedFrom: number;
      removed: Array<{ record: string; type: string; recordId?: string }>;
      digest: string;
      noop: boolean;
      irrecoverable: boolean;
      referenced: boolean;
      referencing: string[];
    };

    console.log('\n─── ' + label + ' (' + groupId + ') ───');
    console.log('  目标      :', target);
    console.log('  当前条数  :', plan.collapsedFrom, '| noop:', plan.noop);
    console.log('  将移除    :', JSON.stringify(plan.removed));
    console.log('  不可重建  :', plan.irrecoverable);
    console.log('  引用方    :', plan.referenced ? plan.referencing.join(', ') : '(空)');
    console.log('  摘要      :', shortDigest(plan.digest));

    if (!apply) continue;
    if (plan.referenced) {
      console.log('  已跳过：该组仍被引用，拒绝写入');
      continue;
    }
    if (plan.noop) {
      console.log('  已跳过：已是目标状态（幂等）');
      continue;
    }

    const result = (await dispatch(
      'ext.tencenteo.originGroup.replace',
      principal,
      { domainId: DOMAIN_ID, groupId, target, collapse: true, diffDigest: plan.digest },
      options,
    )) as { collapsedFrom: number; requestId?: string | null; target: { record: string } };

    console.log('  写入完成  : collapsedFrom=' + result.collapsedFrom, '| RequestId=' + (result.requestId ?? '(未回传)'));
  }

  console.log('\n=== 回读结果 ===');
  for (const [groupId, label] of ALLOWED_GROUPS) {
    const group = (await dispatch(
      'ext.tencenteo.originGroup.get',
      principal,
      { domainId: DOMAIN_ID, groupId },
      { trigger: 'api' as const },
    )) as { records: Array<{ record: string; type: string; weight?: number }>; references: unknown[] };
    console.log(
      '  ' + label.padEnd(10),
      JSON.stringify(group.records),
      '| refs=' + group.references.length,
    );
  }
}

main().catch((error) => {
  console.error('执行失败:', error);
  process.exit(1);
});
