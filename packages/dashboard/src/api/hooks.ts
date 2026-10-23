// TanStack Query hooks + the /events WebSocket. Queries are same-origin to the proxy; the socket
// pushes live decisions/status and we fold them into the query cache so the UI is live without
// polling.
import { useEffect, useRef, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { api, eventsUrl } from './client';
import type {
  Attestation,
  AuditEntry,
  AuditHead,
  Decision,
  DecisionPage,
  Disclosure,
  EventFrame,
  Policy,
  PolicyRule,
  Status,
  VerifyResult,
} from './types';

export function useStatus() {
  return useQuery({ queryKey: ['status'], queryFn: () => api.get<Status>('/status') });
}

export function useDecisions(filter?: { verdict?: string; server?: string }) {
  const qs = new URLSearchParams();
  if (filter?.verdict) qs.set('verdict', filter.verdict);
  if (filter?.server) qs.set('server', filter.server);
  const suffix = qs.toString() ? `?${qs}` : '';
  return useQuery({
    queryKey: ['decisions', filter?.verdict ?? '', filter?.server ?? ''],
    queryFn: () => api.get<DecisionPage>(`/decisions${suffix}`),
  });
}

export function useDecision(id: string | undefined) {
  return useQuery({
    queryKey: ['decision', id],
    queryFn: () => api.get<Decision>(`/decisions/${id}`),
    enabled: !!id,
  });
}

export function usePolicy() {
  return useQuery({ queryKey: ['policy'], queryFn: () => api.get<Policy>('/policy') });
}

export function useAttestations(status?: string) {
  const suffix = status ? `?status=${status}` : '';
  return useQuery({
    queryKey: ['attestations', status ?? ''],
    queryFn: () => api.get<Attestation[]>(`/attestations${suffix}`),
  });
}

export function useAttestation(id: string | undefined) {
  return useQuery({
    queryKey: ['attestation', id],
    queryFn: () => api.get<Attestation>(`/attestations/${id}`),
    enabled: !!id,
  });
}

export function useSubmitAttestation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; cluster: 'devnet' | 'mainnet-beta' }) =>
      api.post<{ txSig: string }>(`/attestations/${v.id}/submit`, { cluster: v.cluster }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['attestations'] }),
  });
}

export function useAuditHead() {
  return useQuery({ queryKey: ['audit', 'head'], queryFn: () => api.get<AuditHead>('/audit/head') });
}

export function useAuditEntries(from: number, to: number) {
  return useQuery({
    queryKey: ['audit', 'entries', from, to],
    queryFn: () => api.get<AuditEntry[]>(`/audit/entries?from=${from}&to=${to}`),
  });
}

export function useVerifyChain() {
  return useMutation({ mutationFn: () => api.post<VerifyResult>('/audit/verify') });
}

export function useDisclose() {
  return useMutation({
    mutationFn: (v: { from: number; to: number }) => api.post<Disclosure>('/audit/disclose', v),
  });
}

export function useSavePolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rules: PolicyRule[]) => api.put<Policy>('/policy', { rules }),
    onSuccess: (p) => qc.setQueryData(['policy'], p),
  });
}

export function useDryRun() {
  return useMutation({
    mutationFn: (payload: string) => api.post<Decision>('/policy/dry-run', { payload }),
  });
}

/** Fold a live decision into every cached decision list (newest first, capped). */
function pushDecision(qc: QueryClient, d: Decision) {
  qc.setQueriesData<DecisionPage>({ queryKey: ['decisions'] }, (prev) => {
    if (!prev) return prev;
    if (prev.items.some((x) => x.id === d.id)) return prev;
    return { ...prev, items: [d, ...prev.items].slice(0, 500) };
  });
}

export type ConnState = 'connecting' | 'open' | 'closed';

/**
 * Subscribe to /events. Returns the live connection state and whether the stream is paused.
 * Reconnects with backoff. Decisions/status/policy/attestation frames update the query cache.
 */
export function useEventStream(paused: boolean) {
  const qc = useQueryClient();
  const [conn, setConn] = useState<ConnState>('connecting');
  const wsRef = useRef<WebSocket | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout>;

    const connect = () => {
      if (closed) return;
      setConn('connecting');
      let ws: WebSocket;
      try {
        ws = new WebSocket(eventsUrl());
      } catch {
        schedule();
        return;
      }
      wsRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        setConn('open');
      };
      ws.onmessage = (ev) => {
        if (pausedRef.current) return;
        let frame: EventFrame;
        try {
          frame = JSON.parse(ev.data);
        } catch {
          return;
        }
        switch (frame.type) {
          case 'decision':
            pushDecision(qc, frame.data);
            break;
          case 'status':
            qc.setQueryData(['status'], frame.data);
            break;
          case 'policy':
            qc.setQueryData(['policy'], frame.data);
            break;
          case 'attestation':
            qc.invalidateQueries({ queryKey: ['attestations'] });
            break;
        }
      };
      ws.onclose = () => {
        setConn('closed');
        schedule();
      };
      ws.onerror = () => ws.close();
    };

    const schedule = () => {
      if (closed) return;
      retry = Math.min(retry + 1, 6);
      timer = setTimeout(connect, 250 * 2 ** retry);
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      wsRef.current?.close();
    };
  }, [qc]);

  return { conn };
}
