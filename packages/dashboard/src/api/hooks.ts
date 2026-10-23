// TanStack Query hooks + the /events WebSocket. Queries are same-origin to the proxy; the socket
// pushes live decisions/status and we fold them into the query cache so the UI is live without
// polling.
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

export function useCreateAttestation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (decisionId: string) => api.post<{ id: string }>('/attestations', { decisionId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['attestations'] }),
  });
}

export function useRevealPayload() {
  return useMutation({
    mutationFn: (id: string) => api.post<{ payload: string }>(`/decisions/${id}/reveal`, undefined, { 'X-Confirm': 'reveal' }),
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
// A tiny in-process event bus: one WebSocket (opened in the Shell) fans frames out to subscribers,
// so pages own their own live behaviour (e.g. the Decisions Live/Paused queue) without a second WS.
type BusCb = (data: any) => void;
const bus = new Map<string, Set<BusCb>>();
function emit(type: string, data: any) {
  bus.get(type)?.forEach((cb) => { try { cb(data); } catch { /* subscriber threw */ } });
}
/** Subscribe to a frame type ('decision' | 'status' | 'policy' | 'attestation'). */
export function useBusEvent(type: string, cb: BusCb) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    const wrapped: BusCb = (d) => ref.current(d);
    let set = bus.get(type);
    if (!set) { set = new Set(); bus.set(type, set); }
    set.add(wrapped);
    return () => { set!.delete(wrapped); };
  }, [type]);
}

export type ConnState = 'connecting' | 'open' | 'closed';

/**
 * Subscribe to /events. Returns the live connection state and whether the stream is paused.
 * Reconnects with backoff. Decisions/status/policy/attestation frames update the query cache.
 */
export function useEventStream(_paused?: boolean) {
  const qc = useQueryClient();
  const [conn, setConn] = useState<ConnState>('connecting');
  const wsRef = useRef<WebSocket | null>(null);

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
        let frame: EventFrame;
        try {
          frame = JSON.parse(ev.data);
        } catch {
          return;
        }
        emit(frame.type, (frame as any).data);
        // Convenience cache updates; decisions are owned by the page (bus) so they are not folded.
        if (frame.type === 'status') qc.setQueryData(['status'], frame.data);
        else if (frame.type === 'policy') qc.setQueryData(['policy'], frame.data);
        else if (frame.type === 'attestation') qc.invalidateQueries({ queryKey: ['attestations'] });
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
