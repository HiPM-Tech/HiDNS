import { describe, expect, it } from 'vitest';
import { parseZoneText } from '../zone-import';

const zone = `$ORIGIN example.com.
$TTL 600
@   IN  SOA ns1.example.com. hostmaster.example.com. ( 2024010101 3600 600 86400 600 )
@   IN  NS  ns1.example.com.
www 120 IN A 1.2.3.4
@       MX  10 mail.example.com.
txt     TXT "v=spf1 include:_spf" " ~all"
alias   CNAME www
_sip._tcp SRV 10 5 5060 sip.example.com.
`;

describe('parseZoneText', () => {
  it('解析常见记录并跳过 SOA/NS', () => {
    const { rows, skipped } = parseZoneText(zone, 'example.com');
    const payloads = rows.filter((row) => row.payload).map((row) => row.payload!);
    expect(skipped).toBe(2);
    expect(payloads).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'www', type: 'A', value: '1.2.3.4', ttl: 120 }),
      expect.objectContaining({ name: '@', type: 'MX', value: 'mail.example.com', mx: 10, ttl: 600 }),
      expect.objectContaining({ name: 'txt', type: 'TXT', value: 'v=spf1 include:_spf ~all', ttl: 600 }),
      expect.objectContaining({ name: 'alias', type: 'CNAME', value: 'www', ttl: 600 }),
      expect.objectContaining({ name: '_sip._tcp', type: 'SRV', value: '10 5 5060 sip.example.com' }),
    ]));
  });

  it('相对名称与完整名称都归一到主机记录', () => {
    const { rows } = parseZoneText('a 60 IN A 1.1.1.1\nb.example.com. 60 IN A 2.2.2.2\n', 'example.com');
    expect(rows.map((row) => row.payload?.name)).toEqual(['a', 'b']);
  });

  it('未知类型进入错误行，不会静默丢弃', () => {
    const { rows } = parseZoneText('x 60 IN NAPTR 1 1 "" "" "" .\n', 'example.com');
    expect(rows[0].error).toMatch(/暂不支持/);
  });
});
