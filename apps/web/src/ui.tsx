import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ApiError } from './api.ts';

/*
 * Shared UI rules (Master Plan §10): every number shows its source and collection time; missing values render
 * as "—" with the reason (never 0); external links open safely; captions render as text (no HTML);
 * empty states differ from errors.
 */

export const fmtNum = (v: number | null | undefined, reason?: string) =>
  v === null || v === undefined ? (
    <span className="muted" title={reason ? `Missing: ${reason}` : 'Not provided'}>
      —
    </span>
  ) : (
    v.toLocaleString()
  );
export const fmtTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');
export const errText = (e: unknown) => (e instanceof ApiError ? `${e.code}: ${e.message}` : String(e));

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  const safe = /^https:\/\//.test(href) ? href : undefined;
  return safe ? (
    <a href={safe} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

export function Status({ s }: { s: string | null | undefined }) {
  if (!s) return <span className="muted">—</span>;
  return <span className={`badge badge-${s.toLowerCase()}`}>{s}</span>;
}

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    fn().then(
      (d) => {
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        setError(errText(e));
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(reload, [reload]);
  return { data, error, loading, reload };
}

/** Poll while `active` (e.g. a job is QUEUED/RUNNING). */
export function usePoll(fn: () => void, active: boolean, ms = 2000) {
  useEffect(() => {
    if (!active) return;
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  }, [fn, active, ms]);
}

export function ErrorBox({ error }: { error: string | null | undefined }) {
  return error ? <div className="error">{error}</div> : null;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted">{children}</p>;
}

export function Loading({ on }: { on: boolean }) {
  return on ? <span className="muted small">Loading…</span> : null;
}

export const ACTIVE = ['QUEUED', 'RUNNING'];
export const PLATFORMS = ['bluesky', 'youtube', 'tiktok', 'facebook', 'instagram', 'threads', 'reddit', 'x', 'pinterest', 'linkedin'];
