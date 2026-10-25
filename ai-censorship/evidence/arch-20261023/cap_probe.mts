
import { createAdapter } from '/workspace/HiDNS/server/src/lib/dns/DnsHelper';
import { providerDefinitionMap } from '/workspace/HiDNS/server/src/lib/dns/providers/registry';
const def = providerDefinitionMap.get('dpdns_reverse')!;
console.log('capabilities:', JSON.stringify(def.capabilities));
const a: any = createAdapter('dpdns_reverse', { rememberToken: 'x' });
console.log('adapter built:', a.constructor.name, '| getDomainList is function:', typeof a.getDomainList === 'function');
