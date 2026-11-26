import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { CollectorError } from '@sss/collector-core';

/**
 * Fetch one public web page (a developer website listed by an app store) without SSRF exposure:
 * - http/https on the default ports only, no credentials in the URL;
 * - every address the hostname resolves to must be public, and the socket connects to the address that was
 *   checked (the check runs inside the connection's DNS lookup, so DNS rebinding cannot swap it afterwards);
 * - redirects are followed manually (max 3) and re-checked; HTML only; size and time are capped.
 */

export interface PageFetchResult {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  redirects: string[];
  html: string;
  fetchedAt: string;
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Address policy; tests may allow loopback. Default: public unicast only. */
  isAllowedAddress?: (address: string) => boolean;
  /** Injectable DNS for tests. */
  lookup?: typeof dnsLookup;
  /** Tests only: local servers listen on random ports. */
  anyPortForTests?: boolean;
}

function v4(a: string): number[] {
  return a.split('.').map(Number);
}

/** True for globally routable unicast addresses; false for private, loopback, link-local, CGNAT, multicast, … */
export function isPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const [a, b] = v4(address) as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 192 && b === 0) return false; // 192.0.0.0/24 and 192.0.2.0/24
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
    if (a === 203 && b === 0) return false;
    return true;
  }
  if (kind === 6) {
    const x = address.toLowerCase();
    if (x === '::' || x === '::1') return false;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPublicAddress(mapped[1]!);
    if (/^f[cd]/.test(x)) return false; // ULA fc00::/7
    if (/^fe[89ab]/.test(x)) return false; // link-local
    if (x.startsWith('ff')) return false; // multicast
    if (x.startsWith('2001:db8') || x.startsWith('64:ff9b') || x.startsWith('2002:')) return false;
    return true;
  }
  return false;
}

export async function fetchPublicPage(input: string, o: SafeFetchOptions = {}): Promise<PageFetchResult> {
  const timeoutMs = o.timeoutMs ?? 10_000;
  const maxBytes = o.maxBytes ?? 1_000_000;
  const maxRedirects = o.maxRedirects ?? 3;
  const allowed = o.isAllowedAddress ?? isPublicAddress;
  const lookupImpl = o.lookup ?? dnsLookup;
  const deadline = Date.now() + timeoutMs;
  const redirects: string[] = [];
  let current = input;

  for (let hop = 0; ; hop++) {
    const url = checkUrl(current, o.anyPortForTests === true);
    const res = await getOnce(url, { deadline, allowed, lookupImpl });
    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      if (hop >= maxRedirects) throw new CollectorError('INVALID_INPUT', `Too many redirects (>${maxRedirects}) from ${input}`);
      current = new URL(res.headers.location, url).toString();
      redirects.push(current);
      continue;
    }
    const status = res.statusCode ?? 0;
    if (status === 404 || status === 410) {
      res.resume();
      throw new CollectorError('NOT_FOUND', `Website returned HTTP ${status}`);
    }
    if (status < 200 || status >= 300) {
      res.resume();
      throw new CollectorError('PROVIDER_UNAVAILABLE', `Website returned HTTP ${status}`);
    }
    const type = String(res.headers['content-type'] ?? '');
    if (!/text\/html|application\/xhtml\+xml/i.test(type)) {
      res.resume();
      throw new CollectorError('INVALID_INPUT', `Website did not return HTML (content-type: ${type || 'none'})`);
    }
    const html = await readCapped(res, maxBytes, deadline);
    return { requestedUrl: input, finalUrl: url.toString(), status, redirects, html, fetchedAt: new Date().toISOString() };
  }
}

function checkUrl(raw: string, anyPort: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CollectorError('INVALID_INPUT', 'Website URL is not valid');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new CollectorError('POLICY_BLOCKED', `Only http(s) websites can be fetched (${url.protocol})`);
  if (url.username || url.password) throw new CollectorError('POLICY_BLOCKED', 'URLs with credentials are not fetched');
  if (!anyPort && url.port && url.port !== '80' && url.port !== '443') throw new CollectorError('POLICY_BLOCKED', `Non-standard port ${url.port} is not fetched`);
  return url;
}

function getOnce(url: URL, c: { deadline: number; allowed: (a: string) => boolean; lookupImpl: typeof dnsLookup }): Promise<IncomingMessage> {
  const remaining = c.deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new CollectorError('TIMEOUT', 'Website fetch timed out'));
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !c.allowed(host)) return Promise.reject(new CollectorError('POLICY_BLOCKED', `Address ${host} is not public`));
  // Resolve, check every address, then connect to the checked one.
  const lookup: LookupFunction = (hostname, options, cb) => {
    c.lookupImpl(hostname, { all: true }, (err, addresses) => {
      if (err) return cb(err, '', 4);
      const list = addresses as LookupAddress[];
      const bad = list.find((a) => !c.allowed(a.address));
      if (!list.length || bad) return cb(new CollectorError('POLICY_BLOCKED', `${hostname} resolves to a non-public address${bad ? ` (${bad.address})` : ''}`) as unknown as NodeJS.ErrnoException, '', 4);
      const first = list[0]!;
      if ((options as { all?: boolean }).all) return (cb as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
      cb(null, first.address, first.family);
    });
  };
  const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
    method: 'GET',
    lookup,
    headers: { 'user-agent': 'SocialSpyAutomation/1.0 (developer-website link check)', accept: 'text/html,application/xhtml+xml' },
    timeout: remaining,
  });
  return new Promise((resolve, reject) => {
    req.on('response', resolve);
    req.on('timeout', () => req.destroy(new CollectorError('TIMEOUT', 'Website fetch timed out')));
    req.on('error', (e) => reject(e instanceof CollectorError ? e : new CollectorError('PROVIDER_UNAVAILABLE', `Website fetch failed: ${(e as Error).message}`)));
    req.end();
  });
}

function readCapped(res: IncomingMessage, maxBytes: number, deadline: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => res.destroy(new CollectorError('TIMEOUT', 'Website fetch timed out')), Math.max(1, deadline - Date.now()));
    res.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        // Keep what we have: profile links are usually in the header or footer of the first megabyte.
        chunks.push(c.subarray(0, c.length - (size - maxBytes)));
        clearTimeout(timer);
        res.destroy();
        resolve(Buffer.concat(chunks).toString('utf8'));
        return;
      }
      chunks.push(c);
    });
    res.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    res.on('error', (e) => {
      clearTimeout(timer);
      reject(e instanceof CollectorError ? e : new CollectorError('PROVIDER_UNAVAILABLE', `Website fetch failed: ${e.message}`));
    });
  });
}
