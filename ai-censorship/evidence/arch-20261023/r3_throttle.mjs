
const B = 'http://127.0.0.1:3911/api/security/password-strength';
const PW = 'Ab1!'.repeat(18).slice(0, 72);
async function round(label, spoof) {
  const tasks = Array.from({ length: 30 }, (_, i) => fetch(B, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(spoof ? { 'X-Forwarded-For': '203.0.113.' + (i + 1) } : {}) },
    body: JSON.stringify({ password: PW }),
  }).then(r => r.status));
  const codes = await Promise.all(tasks);
  const n = (c) => codes.filter(x => x === c).length;
  console.log(label.padEnd(26), '200=' + n(200), '429=' + n(429), 'other=' + (codes.length - n(200) - n(429)));
}
await round('并发 30（无 XFF）', false);
await new Promise(r => setTimeout(r, 1500));
await round('并发 30（每条换 XFF）', true);
