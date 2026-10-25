
process.env.DB_TYPE = 'sqlite';
process.env.DB_PATH = '/tmp/res-audit/data/app.db';
process.env.HIDNS_LOG_LEVEL = 'error';
async function main(){
  const { connect } = await import('/workspace/HiDNS/server/src/db/dal/connection');
  const { GroupedDomainsCacheOperations, SystemCacheOperations } = await import('/workspace/HiDNS/server/src/db/bal/business-adapter');
  await connect();
  const row = await GroupedDomainsCacheOperations.get(3, 'domain');
  const raw = await SystemCacheOperations.get('grouped_cache_ver');
  console.log('CACHE_ROW version=' + JSON.stringify(row && row.version) + ' typeof=' + typeof (row && row.version) + ' bytes=' + (row ? row.cacheData.length : 0));
  console.log('GLOBAL  version=' + JSON.stringify(raw) + ' typeof=' + typeof raw + ' parseInt=' + parseInt(String(raw),10));
  console.log('STRICT_EQUAL=' + (row && row.version === parseInt(String(raw),10)));
  process.exit(0);
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
