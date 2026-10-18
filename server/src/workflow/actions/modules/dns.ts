import type { NamespaceClaim } from '../../../types/namespace';
import type { ActionDeclaration, BrandedActionHandler } from '../types';
import { dnsRecordActions, dnsRecordHandlers } from '../dns/record';
import { dnsDomainActions, dnsDomainHandlers } from '../dns/domain';

/** 工作流认领 dns 顶级前缀，并二次下派二级前缀 record / domain */
export const namespace = {
  owner: 'workflow',
  top: 'dns',
  second: ['record', 'domain'],
} as const satisfies NamespaceClaim;

export const declarations: ActionDeclaration[] = [...dnsRecordActions, ...dnsDomainActions];
export const handlers: Record<string, BrandedActionHandler> = { ...dnsRecordHandlers, ...dnsDomainHandlers };
