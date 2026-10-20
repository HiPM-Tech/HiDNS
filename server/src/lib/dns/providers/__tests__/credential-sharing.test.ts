import { describe, it, expect } from 'vitest';
import {
  CREDENTIAL_EXPORTS,
  CREDENTIAL_IMPORTS,
  evaluateCredentialSharing,
  findSharingInconsistencies,
  listSharingParticipants,
  mayReuseCredentials,
} from '../credential-sharing';
import { PROVIDER_TYPES } from '../registry';

/**
 * 跨提供商凭据复用必须**两端相互声明**。
 *
 * 单边声明即放行的话，任何提供商实现只要写一句"我可以复用 X 的凭据"，
 * 就能拿到 X 的 SecretId / SecretKey —— 这正是要防的注入面。
 */
describe('凭据复用的双向声明', () => {
  it('当前声明允许 EdgeOne 复用 DNSPod 凭据', () => {
    expect(mayReuseCredentials('tencenteo', 'dnspod')).toBe(true);
  });

  it('方向反了不放行（DNSPod 不得复用 EdgeOne 的凭据）', () => {
    expect(mayReuseCredentials('dnspod', 'tencenteo')).toBe(false);
  });

  it('未声明过的组合一律不放行', () => {
    for (const [consumer, source] of [
      ['tencenteo', 'cloudflare'],
      ['cloudflare', 'dnspod'],
      ['virtual', 'dnspod'],
      ['', ''],
    ]) {
      expect(mayReuseCredentials(consumer, source)).toBe(false);
    }
  });

  it('只有消费方声明、导出方没允许 → 不放行', () => {
    const imports = { attacker: ['victim'] };
    const exports: Record<string, readonly string[]> = {};
    expect(evaluateCredentialSharing(imports, exports, 'attacker', 'victim')).toBe(false);
  });

  it('只有导出方允许、消费方没申请 → 不放行', () => {
    const imports: Record<string, readonly string[]> = {};
    const exports = { victim: ['attacker'] };
    expect(evaluateCredentialSharing(imports, exports, 'attacker', 'victim')).toBe(false);
  });

  it('两端都声明才放行', () => {
    const imports = { attacker: ['victim'] };
    const exports = { victim: ['attacker'] };
    expect(evaluateCredentialSharing(imports, exports, 'attacker', 'victim')).toBe(true);
  });

  it('现有声明表自身一致，没有单边条目', () => {
    expect(findSharingInconsistencies()).toEqual([]);
  });

  it('声明里出现的每个提供商类型都真实存在', () => {
    const { importers, sources } = listSharingParticipants();
    for (const type of [...importers, ...sources]) {
      expect(PROVIDER_TYPES, `未知提供商: ${type}`).toContain(type);
    }
  });

  it('声明表里每个条目都是双向成对的', () => {
    for (const [consumer, sources] of Object.entries(CREDENTIAL_IMPORTS)) {
      for (const source of sources) {
        expect(CREDENTIAL_EXPORTS[source] ?? []).toContain(consumer);
      }
    }
    for (const [source, consumers] of Object.entries(CREDENTIAL_EXPORTS)) {
      for (const consumer of consumers) {
        expect(CREDENTIAL_IMPORTS[consumer] ?? []).toContain(source);
      }
    }
  });
});
