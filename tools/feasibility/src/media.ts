import { redactUrl } from '@sss/collector-core';

export interface MediaProbe {
  url: string;
  host: string;
  status: number | null;
  contentType: string | null;
  cacheControl: string | null;
  expires: string | null;
  /** URL carries signature/expiry query params (likely to expire). */
  looksSigned: boolean;
  error?: string;
}

const SIGNED_PARAM = /^(expires?|exp|sig|signature|x-amz-.*|oh|oe|token|policy|key-pair-id)$/i;

/**
 * HEAD-only probe of a public media/thumbnail URL to learn whether it is signed/expiring.
 * Never downloads the body; only allowlisted CDN hosts (SSRF guard).
 */
export async function probeMedia(url: string, allowedHosts: string[], timeoutMs = 8000): Promise<MediaProbe> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { url, host: '', status: null, contentType: null, cacheControl: null, expires: null, looksSigned: false, error: 'invalid URL' };
  }
  const looksSigned = [...u.searchParams.keys()].some((k) => SIGNED_PARAM.test(k));
  const base = { url: redactUrl(url), host: u.hostname, looksSigned };
  if (u.protocol !== 'https:' || !allowedHosts.includes(u.hostname)) {
    return { ...base, status: null, contentType: null, cacheControl: null, expires: null, error: 'host not on media allowlist' };
  }
  try {
    const res = await fetch(u, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    return {
      ...base,
      status: res.status,
      contentType: res.headers.get('content-type'),
      cacheControl: res.headers.get('cache-control'),
      expires: res.headers.get('expires'),
    };
  } catch (e) {
    return { ...base, status: null, contentType: null, cacheControl: null, expires: null, error: String((e as Error).message) };
  }
}
