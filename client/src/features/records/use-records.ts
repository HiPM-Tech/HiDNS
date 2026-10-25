import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createRecord, deleteRecord, getDomainDetail, listRecordLines, listRecords, listRecordTypes,
  setRecordStatus, updateRecord, type RecordPayload, type RecordQuery,
} from './api';

export function useDomainDetail(domainId: number) {
  return useQuery({
    queryKey: ['domain', domainId],
    queryFn: () => getDomainDetail(domainId),
    staleTime: 60_000,
    enabled: domainId > 0,
  });
}

export function useRecords(domainId: number, query: RecordQuery) {
  return useQuery({
    queryKey: ['records', domainId, query],
    queryFn: () => listRecords(domainId, query),
    staleTime: 10_000,
    enabled: domainId > 0,
  });
}

export function useRecordLines(domainId: number) {
  return useQuery({
    queryKey: ['record-lines', domainId],
    queryFn: () => listRecordLines(domainId),
    staleTime: 5 * 60_000,
    enabled: domainId > 0,
  });
}

export function useRecordTypes(domainId: number) {
  return useQuery({
    queryKey: ['record-types', domainId],
    queryFn: () => listRecordTypes(domainId),
    staleTime: 5 * 60_000,
    enabled: domainId > 0,
  });
}

export function useSaveRecord(domainId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ recordId, payload }: { recordId?: string; payload: RecordPayload }): Promise<unknown> =>
      recordId ? updateRecord(domainId, recordId, payload) : createRecord(domainId, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['records', domainId] });
      void queryClient.invalidateQueries({ queryKey: ['domain', domainId] });
      void queryClient.invalidateQueries({ queryKey: ['domains'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useDeleteRecord(domainId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (recordId: string) => deleteRecord(domainId, recordId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['records', domainId] });
      void queryClient.invalidateQueries({ queryKey: ['domain', domainId] });
      // 记录数变化会反映到域名列表与仪表盘
      void queryClient.invalidateQueries({ queryKey: ['domains'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useToggleRecordStatus(domainId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ recordId, status }: { recordId: string; status: 0 | 1 }) => setRecordStatus(domainId, recordId, status),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['records', domainId] });
    },
  });
}
