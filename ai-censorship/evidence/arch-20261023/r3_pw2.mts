
import crypto from 'node:crypto';
import { checkPasswordStrength } from '/workspace/HiDNS/server/src/service/securityPolicy';
let worst = 0, worstPw = '';
const samples: string[] = [];
for (let i = 0; i < 12; i++) samples.push(crypto.randomBytes(54).toString('base64').slice(0, 72));
// 也测「结构化但高熵」的形式：单词 + 数字 + 符号拼接
samples.push('Tr0ub4dor&3'.repeat(6).slice(0, 72));
samples.push('c0rr3ct-h0rs3-b4tt3ry-st4pl3-v1ct0r1n0us-qu3st10n-m4rk-2026-x9!!'.slice(0,72));
for (const pw of samples) {
  const t0 = process.hrtime.bigint();
  checkPasswordStrength(pw);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (ms > worst) { worst = ms; worstPw = pw; }
  process.stdout.write(ms.toFixed(1) + 'ms ');
}
console.log('');
console.log('worst =', worst.toFixed(1) + 'ms', '| 单 IP 10 req/s 时的 CPU 占用比 =', (worst * 10 / 1000).toFixed(2) + ' core');
