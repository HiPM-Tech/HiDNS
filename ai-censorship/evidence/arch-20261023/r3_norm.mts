
import { normalizeDomain, getRootDomain } from '/workspace/HiDNS/server/src/utils/domain';
const cases = ['ｅｘａｍｐｌｅ．com', 'EXＡＭＰＬＥ.com', '例え.テスト', 'ｅｘａｍｐｌｅ.com.'];
for (const c of cases) console.log(JSON.stringify(c), '->', JSON.stringify(normalizeDomain(c)), '| root=', JSON.stringify(getRootDomain(normalizeDomain(c))));
