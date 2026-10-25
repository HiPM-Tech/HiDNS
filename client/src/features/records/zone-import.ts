import type { ParsedRow } from './batch-import-dialog';
import type { RecordPayload } from './api';

const IMPORTABLE = new Set(['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'SRV', 'CAA']);
const SKIPPED = new Set(['SOA', 'NS', 'DNSKEY', 'RRSIG', 'NSEC', 'NSEC3', 'PTR']);

/** 去掉引号外的注释与行尾空白 */
function stripComment(line: string): string {
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    if (ch === ';' && !quoted) return line.slice(0, i);
  }
  return line;
}

/** 按空白切分，引号内整体保留（含空格） */
function tokenize(line: string): string[] {
  return line.match(/(?:"(?:[^"\\]|\\.)*"|\S)+/g) ?? [];
}

function unquote(token: string): string {
  return token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1).replace(/\\"/g, '"') : token;
}

export type ZoneNameFormat = 'relative' | 'full';

/** 全名转主机记录：example.com. → @、www.example.com. → www；域外名称返回 null */
function fullNameToHost(rawName: string, origin: string): string | null {
  const fqdn = rawName.endsWith('.') ? rawName.slice(0, -1) : rawName;
  const lower = fqdn.toLowerCase();
  const originLower = origin.toLowerCase().replace(/\.$/, '');
  if (lower === originLower) return '@';
  if (lower.endsWith('.' + originLower)) return fqdn.slice(0, fqdn.length - originLower.length - 1);
  return null;
}

function normalizeName(rawName: string | undefined, origin: string, format: ZoneNameFormat): string | null {
  const name = (rawName ?? '@').trim();
  if (!name || name === '@' || name === '.') return '@';
  if (format === 'relative') {
    // 相对名称：只去掉结尾的点，不把域名后缀当 FQDN 处理
    return name.endsWith('.') ? name.slice(0, -1) : name;
  }
  // 完整名称：文件里是 FQDN（可能省略结尾点），统一转成主机记录
  return fullNameToHost(name, origin);
}

/**
 * 解析 BIND zone 文本为批量导入行。
 * 支持：$ORIGIN、$TTL、括号续行、行内注释、引号、相对/绝对名称；
 * 跳过 SOA/NS/PTR 等由提供商托管的记录（计入 skipped）。
 */
export function parseZoneText(text: string, origin: string, format: ZoneNameFormat = 'relative'): { rows: ParsedRow[]; skipped: number } {
  const rows: ParsedRow[] = [];
  const logical: Array<{ line: number; text: string }> = [];
  let buffer = '';
  let bufferLine = 0;
  let depth = 0;

  text.split(/\r?\n/).forEach((raw, index) => {
    const cleaned = stripComment(raw).trim();
    if (!cleaned) return;
    if (!buffer) bufferLine = index + 1;
    buffer += (buffer ? ' ' : '') + cleaned;
    depth += (cleaned.match(/\(/g) ?? []).length;
    depth -= (cleaned.match(/\)/g) ?? []).length;
    if (depth <= 0) {
      logical.push({ line: bufferLine, text: buffer.replace(/[()]/g, ' ') });
      buffer = '';
      depth = 0;
    }
  });
  if (buffer) logical.push({ line: bufferLine, text: buffer.replace(/[()]/g, ' ') });

  let currentOrigin = origin.replace(/\.$/, '');
  let defaultTtl: number | undefined;
  let lastName = '@';
  let skipped = 0;

  for (const { line, text: logicalText } of logical) {
    const trimmed = logicalText.trim();
    const upper = trimmed.toUpperCase();
    if (upper.startsWith('$ORIGIN')) {
      currentOrigin = trimmed.split(/\s+/)[1]?.replace(/\.$/, '') || currentOrigin;
      continue;
    }
    if (upper.startsWith('$TTL')) {
      const ttl = Number(trimmed.split(/\s+/)[1]);
      if (Number.isFinite(ttl) && ttl > 0) defaultTtl = ttl;
      continue;
    }
    if (upper.startsWith('$INCLUDE')) { skipped += 1; continue; }

    const tokens = tokenize(trimmed);
    if (tokens.length === 0) continue;

    // BIND 语法：行首空白表示沿用上一条记录的 owner
    const startsWithSpace = /^\s/.test(logicalText);
    let index = 0;
    const owner = startsWithSpace ? lastName : tokens[index++];
    if (!startsWithSpace) lastName = owner;

    let ttl: number | undefined = defaultTtl;
    if (tokens[index] && /^\d+$/.test(tokens[index]) && tokens[index + 1]) {
      // 「name TTL IN TYPE」或「name TTL TYPE」
      const candidate = Number(tokens[index]);
      const next = tokens[index + 1].toUpperCase();
      if (next === 'IN' || IMPORTABLE.has(next) || SKIPPED.has(next)) {
        ttl = candidate;
        index += 1;
      }
    }
    if (tokens[index]?.toUpperCase() === 'IN') index += 1;
    const type = tokens[index]?.toUpperCase() ?? '';
    index += 1;

    if (SKIPPED.has(type)) { skipped += 1; continue; }
    if (!IMPORTABLE.has(type)) {
      rows.push({ line, raw: trimmed, error: `暂不支持导入 ${type || '未知'} 记录` });
      continue;
    }

    const rdata = tokens.slice(index);
    if (rdata.length === 0) {
      rows.push({ line, raw: trimmed, error: '缺少记录值' });
      continue;
    }

    const normalizedName = normalizeName(owner, currentOrigin, format);
    if (normalizedName === null) {
      rows.push({ line, raw: trimmed, error: `记录名 ${owner} 不属于域名 ${origin}` });
      continue;
    }

    const payload: RecordPayload = {
      name: normalizedName,
      type,
      value: '',
      ttl,
    };

    if (type === 'MX') {
      const priority = Number(rdata[0]);
      if (!Number.isFinite(priority)) {
        rows.push({ line, raw: trimmed, error: 'MX 优先级不是数字' });
        continue;
      }
      payload.mx = priority;
      payload.value = rdata.slice(1).map(unquote).join(' ').replace(/\.$/, '');
    } else if (type === 'TXT') {
      payload.value = rdata.map(unquote).join('');
    } else {
      payload.value = rdata.map(unquote).join(' ').replace(/\.$/, '');
    }

    if (!payload.value) {
      rows.push({ line, raw: trimmed, error: '记录值为空' });
      continue;
    }
    rows.push({ line, raw: trimmed, payload });
  }

  return { rows, skipped };
}
