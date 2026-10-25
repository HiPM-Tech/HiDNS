import { useQuery } from '@tanstack/react-query';
import { listAuditLogs, type AuditQuery } from './api';

export function useAuditLogs(query: AuditQuery) {
  return useQuery({
    queryKey: ['audit-logs', query],
    queryFn: () => listAuditLogs(query),
    staleTime: 15_000,
  });
}
