import { useState } from 'react';
import { api, type Page, type Project } from '../api.ts';
import { Empty, errText, ErrorBox, ExternalLink, fmtNum, fmtTime, Loading, Status, useLoad } from '../ui.tsx';

/*
 * App Spy (Phase 9, P9-03, ADR-0018): Apple App Store listings via the official iTunes Search API, and
 * app → developer website → social profile links with evidence. No icons or screenshots (Apple promo-content
 * rule); every app links to its App Store page; Google Play is BLOCKED (no official API).
 */

interface StoreApp {
  storeAppId: string;
  country: string;
  bundleId: string | null;
  name: string;
  developerId: string | null;
  developerName: string | null;
  websiteUrl: string | null;
  storeUrl: string;
  genre: string | null;
  price: number | null;
  currency: string | null;
  rating: number | null;
  ratingCount: number | null;
  version: string | null;
  storeUpdatedAt: string | null;
  missing?: Record<string, string>;
  trackedId?: string | null;
}
interface TrackedApp extends StoreApp {
  id: string;
  sellerName: string | null;
  developerUrl: string | null;
  releasedAt: string | null;
  description: string | null;
  details: { genres?: string[]; contentRating?: string | null; languages?: string[]; minimumOsVersion?: string | null; missing?: Record<string, string> };
  status: string;
  provenance: { providerId: string; policyId: string; collectedAt: string };
  projectIds: string[];
  linkCount?: number;
}
interface AppLink {
  id: string;
  platform: string;
  handle: string;
  profileUrl: string;
  method: string;
  confidence: string;
  status: string;
  evidence: { websiteUrl: string; finalUrl: string; redirects: string[]; sameSite: boolean; href: string; fetchedAt: string; storeUrl: string };
  account: { id: string; platform: string; username: string | null; displayName: string | null; profileUrl: string } | null;
  decidedAt: string | null;
}
interface AppDetail extends TrackedApp {
  links: AppLink[];
  policy: Policy;
}
interface Policy {
  status: string;
  checkedAt: string;
  policyId: string;
  storeMetadata: boolean;
  historicalSnapshots: boolean;
  export: boolean;
  proposalStatus: string | null;
  limitations: string[];
}

const COUNTRIES = ['us', 'vn', 'gb', 'jp', 'kr', 'de', 'fr', 'in', 'br', 'au', 'ca', 'sg', 'th', 'id'];
const rating = (a: StoreApp) =>
  a.rating === null ? (
    fmtNum(null, a.missing?.rating)
  ) : (
    <>
      {a.rating.toFixed(2)} <span className="muted small">({fmtNum(a.ratingCount)})</span>
    </>
  );
const price = (a: StoreApp) => (a.price === null ? fmtNum(null) : a.price === 0 ? 'Free' : `${a.price} ${a.currency ?? ''}`);

function PolicyNotice({ p }: { p: Policy | null }) {
  if (!p) return null;
  return (
    <div className="notice small">
      Source: Apple iTunes Search API (official, public; about 20 calls per minute), checked {p.checkedAt}. Policy <code>{p.policyId}</code>: only the latest listing of tracked apps is kept
      {p.historicalSnapshots ? '' : ' (no history)'}
      {p.export ? '' : ', no export'}, no icons or screenshots. {p.proposalStatus === 'PENDING_PRODUCT_OWNER_APPROVAL' && 'History and export wait for the Product Owner to approve the policy proposal.'} Google Play: BLOCKED (no official
      API). Downloads, revenue and rankings are not available and are never estimated.
    </div>
  );
}

/* ---------------- list + search ---------------- */
export function Apps() {
  const policy = useLoad(() => api<Policy>('/apps/policy'), []);
  const projects = useLoad(() => api<Page<Project>>('/projects?limit=100'), []);
  const [projectId, setProjectId] = useState('');
  const tracked = useLoad(() => api<{ items: TrackedApp[] }>(`/apps${projectId ? `?projectId=${projectId}` : ''}`), [projectId]);
  const [term, setTerm] = useState('');
  const [country, setCountry] = useState('us');
  const [results, setResults] = useState<{ items: StoreApp[]; note: string } | null>(null);
  const [input, setInput] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search() {
    setBusy(true);
    setErr(null);
    try {
      setResults(await api(`/apps/search?term=${encodeURIComponent(term.trim())}&country=${country}`));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }
  async function track(value: string, c?: string) {
    setBusy(true);
    setErr(null);
    try {
      const a = await api<TrackedApp>('/apps', { method: 'POST', body: { input: value, ...(c ? { country: c } : {}), ...(projectId ? { projectId } : {}) } });
      location.hash = `#/app/${a.id}`;
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  }

  return (
    <>
      <h2>App Spy</h2>
      <PolicyNotice p={policy.data} />
      <div className="filters">
        <label>
          Search the App Store
          <input value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && term.trim() && search()} placeholder="note taking" />
        </label>
        <label>
          Storefront
          <select value={country} onChange={(e) => setCountry(e.target.value)}>
            {COUNTRIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <button disabled={!term.trim() || busy} onClick={search}>
          Search
        </button>
        <span style={{ width: 24 }} />
        <label>
          Or track by App Store link, id or bundle id
          <input className="narrow" style={{ width: 320 }} value={input} onChange={(e) => setInput(e.target.value)} placeholder="https://apps.apple.com/us/app/…/id123456789" />
        </label>
        <label>
          Add to project
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">— none —</option>
            {projects.data?.items.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <button disabled={!input.trim() || busy} onClick={() => track(input)}>
          Track app
        </button>
      </div>
      <ErrorBox error={err ?? policy.error} />
      {results && (
        <>
          <h3>Search results</h3>
          <p className="muted small">{results.note}</p>
          {results.items.length === 0 ? <Empty>No apps found.</Empty> : <AppTable items={results.items} onTrack={(a) => track(a.storeAppId, a.country)} busy={busy} />}
        </>
      )}
      <h3>Tracked apps{projectId ? ' in this project' : ''}</h3>
      <ErrorBox error={tracked.error} />
      <Loading on={tracked.loading} />
      {tracked.data && tracked.data.items.length === 0 && <Empty>No tracked apps yet.</Empty>}
      {tracked.data && tracked.data.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>App</th>
              <th>Developer</th>
              <th>Store</th>
              <th>Rating</th>
              <th>Version</th>
              <th>Social links</th>
              <th>Collected</th>
            </tr>
          </thead>
          <tbody>
            {tracked.data.items.map((a) => (
              <tr key={a.id}>
                <td>
                  <a href={`#/app/${a.id}`}>{a.name}</a> {a.status !== 'ACTIVE' && <Status s={a.status} />}
                  <div className="muted small">{a.genre}</div>
                </td>
                <td>{a.developerName ?? '—'}</td>
                <td className="small">
                  <ExternalLink href={a.storeUrl}>App Store ({a.country.toUpperCase()})</ExternalLink>
                </td>
                <td>{rating(a)}</td>
                <td>{a.version ?? '—'}</td>
                <td>{a.linkCount ?? 0}</td>
                <td className="small">{fmtTime(a.provenance.collectedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function AppTable({ items, onTrack, busy }: { items: StoreApp[]; onTrack: (a: StoreApp) => void; busy: boolean }) {
  return (
    <table>
      <thead>
        <tr>
          <th>App</th>
          <th>Developer</th>
          <th>Price</th>
          <th>Rating (count)</th>
          <th>Updated</th>
          <th>Website</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {items.map((a) => (
          <tr key={`${a.country}-${a.storeAppId}`}>
            <td>
              <ExternalLink href={a.storeUrl}>{a.name}</ExternalLink>
              <div className="muted small">
                {a.genre} · <code>{a.bundleId}</code>
              </div>
            </td>
            <td>{a.developerName ?? '—'}</td>
            <td>{price(a)}</td>
            <td>{rating(a)}</td>
            <td className="small">{a.storeUpdatedAt ? new Date(a.storeUpdatedAt).toLocaleDateString() : '—'}</td>
            <td className="small">{a.websiteUrl ? <ExternalLink href={a.websiteUrl}>{new URL(a.websiteUrl).hostname}</ExternalLink> : <span className="muted" title="The developer lists no website">—</span>}</td>
            <td>{a.trackedId ? <a href={`#/app/${a.trackedId}`}>Tracked →</a> : <button disabled={busy} onClick={() => onTrack(a)}>Track</button>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ---------------- one app ---------------- */
export function AppPage({ id }: { id: string }) {
  const app = useLoad(() => api<AppDetail>(`/apps/${id}`), [id]);
  const [dev, setDev] = useState<{ developer: { name: string } | null; items: StoreApp[] } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<string | void>) {
    setBusy(true);
    setMsg(null);
    try {
      const t = await fn();
      if (t) setMsg({ ok: true, text: t });
      app.reload();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  if (app.error) return <ErrorBox error={app.error} />;
  if (!app.data) return <Loading on />;
  const a = app.data;
  return (
    <>
      <p className="small">
        <a href="#/apps">← App Spy</a>
      </p>
      <h2 style={{ marginBottom: 4 }}>
        {a.name} {a.status !== 'ACTIVE' && <Status s={a.status} />}
      </h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {a.developerName} · {a.genre} · <code>{a.bundleId}</code> · storefront {a.country.toUpperCase()}
      </p>
      <PolicyNotice p={a.policy} />
      <div className="stats">
        <div>
          <div className="muted small">Rating</div>
          <b>{rating(a)}</b>
        </div>
        <div>
          <div className="muted small">Price</div>
          <b>{price(a)}</b>
        </div>
        <div>
          <div className="muted small">Version</div>
          <b>{a.version ?? '—'}</b>
        </div>
        <div>
          <div className="muted small">Last update</div>
          <b>{a.storeUpdatedAt ? new Date(a.storeUpdatedAt).toLocaleDateString() : '—'}</b>
        </div>
        <div>
          <div className="muted small">First release</div>
          <b>{a.releasedAt ? new Date(a.releasedAt).toLocaleDateString() : '—'}</b>
        </div>
      </div>
      <p className="small muted">
        Source {a.provenance.providerId} · collected {fmtTime(a.provenance.collectedAt)} · <ExternalLink href={a.storeUrl}>App Store page</ExternalLink>
        {a.developerUrl && (
          <>
            {' '}
            · <ExternalLink href={a.developerUrl}>developer page</ExternalLink>
          </>
        )}
      </p>
      <div className="row">
        <button disabled={busy} onClick={() => run(async () => (await api(`/apps/${id}/refresh`, { method: 'POST' }), 'Listing refreshed.'))}>
          Refresh listing
        </button>
        <button disabled={busy || !a.developerId} onClick={() => run(async () => setDev(await api(`/apps/${id}/developer-apps`)))}>
          Developer’s other apps
        </button>
        <button
          disabled={busy}
          onClick={() =>
            run(async () => {
              if (a.projectIds.length && !window.confirm('Stop tracking this app everywhere?')) return;
              await api(`/apps/${id}`, { method: 'DELETE' });
              location.hash = '#/apps';
            })
          }
        >
          Stop tracking
        </button>
      </div>
      {msg && <div className={msg.ok ? 'ok' : 'error'}>{msg.text}</div>}

      <h3>Social accounts (from the developer website)</h3>
      <p className="muted small">
        Evidence chain: App Store listing → developer website the store lists ({a.websiteUrl ? <ExternalLink href={a.websiteUrl}>{a.websiteUrl}</ExternalLink> : 'none listed'}) → profile links published on that page. Names are never
        matched. HIGH = the page stayed on the listed site; MEDIUM = it redirected to another site. Confirm or reject each one.
      </p>
      <div className="row">
        <button
          disabled={busy || !a.websiteUrl}
          title={a.websiteUrl ? '' : 'The listing has no developer website'}
          onClick={() => run(async () => {
            const r = await api<{ found: number; created: number; matchedTrackedAccounts: number; finalUrl: string }>(`/apps/${id}/discover-links`, { method: 'POST' });
            return `Checked ${r.finalUrl}: ${r.found} profile link(s), ${r.created} new, ${r.matchedTrackedAccounts} match an account you track.`;
          })}
        >
          Check developer website
        </button>
      </div>
      {a.links.length === 0 ? (
        <Empty>{a.websiteUrl ? 'No links checked yet.' : 'This listing has no developer website, so no account can be linked with evidence.'}</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Profile</th>
              <th>Confidence</th>
              <th>Evidence</th>
              <th>Tracked account</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {a.links.map((l) => (
              <tr key={l.id}>
                <td>
                  {l.platform} · <ExternalLink href={l.profileUrl}>{l.handle}</ExternalLink>
                </td>
                <td>
                  <span className={`badge badge-${l.confidence === 'HIGH' ? 'ok' : 'paused'}`}>{l.confidence}</span>
                </td>
                <td className="small">
                  link <code>{l.evidence.href}</code> on <ExternalLink href={l.evidence.finalUrl}>{new URL(l.evidence.finalUrl).hostname}</ExternalLink>
                  {l.evidence.redirects.length > 0 && <> (redirected from {new URL(l.evidence.websiteUrl).hostname})</>}
                  <div className="muted">checked {fmtTime(l.evidence.fetchedAt)}</div>
                </td>
                <td>{l.account ? <a href={`#/account/${l.account.id}`}>{l.account.username ?? l.account.displayName}</a> : <span className="muted">not tracked</span>}</td>
                <td>
                  <Status s={l.status} />
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {l.status !== 'CONFIRMED' && (
                    <button disabled={busy} onClick={() => run(() => api(`/app-links/${l.id}`, { method: 'PATCH', body: { status: 'CONFIRMED' } }).then(() => undefined))}>
                      Confirm
                    </button>
                  )}{' '}
                  {l.status !== 'REJECTED' && (
                    <button disabled={busy} onClick={() => run(() => api(`/app-links/${l.id}`, { method: 'PATCH', body: { status: 'REJECTED' } }).then(() => undefined))}>
                      Reject
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {dev && (
        <>
          <h3>Other apps by {dev.developer?.name ?? a.developerName}</h3>
          {dev.items.length === 0 ? <Empty>None.</Empty> : <AppTable items={dev.items} busy={busy} onTrack={(x) => run(async () => (await api('/apps', { method: 'POST', body: { input: x.storeAppId, country: x.country } }), `Tracking ${x.name}.`))} />}
        </>
      )}

      {a.description && (
        <details>
          <summary>Store description</summary>
          <p className="bio small">{a.description}</p>
        </details>
      )}
    </>
  );
}
