import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api.ts';
import { useLoad } from './ui.tsx';

/*
 * Setup guide dialog: a live checklist built from GET /setup/status (booleans and counts only, never secrets).
 * Opens once on the first visit and from the sidebar. Settings live in `.env`; after editing it, restart the app.
 */

export interface SetupStatus {
  checkedAt: string;
  app: { database: boolean; queueDriver: 'bullmq' | 'inline'; schedulerPaused: boolean };
  sources: {
    bluesky: { enabled: boolean; status: string | null; appPasswordSet: boolean; policyProposal: string | null };
    youtube: { enabled: boolean; status: string | null; apiKeySet: boolean };
    appleAppStore: { policyProposal: string | null };
  };
  features: {
    ai: { anthropicKeySet: boolean };
    notifications: { telegram: boolean; email: boolean; webhook: boolean };
    backup: { passphraseSet: boolean; keyFileExists: boolean; backups: number };
    remoteAccess: { loopbackOnly: boolean; apiTokenSet: boolean };
  };
  data: { projects: number; trackedAccounts: number; activeKeywords: number; posts: number; apps: number; workflows: number };
}

const SEEN_KEY = 'sss-setup-guide-seen';
export function guideSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return true;
  }
}
export function markGuideSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* storage unavailable */
  }
}

/** Core steps counted in the sidebar progress. */
function coreSteps(s: SetupStatus) {
  return [true, s.data.projects > 0, s.data.trackedAccounts > 0, s.sources.youtube.apiKeySet];
}

export function useSetupStatus() {
  const r = useLoad(() => api<SetupStatus>('/setup/status'), []);
  const core = r.data ? coreSteps(r.data) : [];
  return { ...r, done: core.filter(Boolean).length, total: core.length || 4 };
}

function Snippet({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="snippet">
      <pre>{text}</pre>
      <button
        onClick={() =>
          navigator.clipboard?.writeText(text).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => {},
          )
        }
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

type Kind = 'done' | 'todo' | 'optional' | 'decision';
function Step({ kind, title, badge, children }: { kind: Kind; title: string; badge?: ReactNode; children?: ReactNode }) {
  const icon = kind === 'done' ? '✓' : kind === 'decision' ? '!' : kind === 'todo' ? '•' : '+';
  return (
    <div className={`step${kind === 'done' ? ' done' : ''}`}>
      <span className={`step-icon ${kind}`} aria-label={kind}>
        {icon}
      </span>
      <div>
        <div className="step-title">
          {title} {badge}
        </div>
        {children}
      </div>
    </div>
  );
}

const yes = (on: boolean, onText = 'Configured', offText = 'Not set') => <span className={`badge badge-${on ? 'ok' : 'skipped'}`}>{on ? onText : offText}</span>;

export function SetupGuide({ status: s, error, onClose, onRecheck }: { status: SetupStatus | null; error: string | null; onClose: () => void; onRecheck: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Once per opening: focus the close button, close on Escape, lock page scroll.
  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCloseRef.current();
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, []);
  const go = (hash: string) => () => {
    onClose();
    location.hash = hash;
  };
  const core = s ? coreSteps(s) : [];
  const done = core.filter(Boolean).length;
  const n = s?.features.notifications;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="setup-title" tabIndex={-1} ref={dialogRef}>
        <div className="modal-head">
          <span className="brand-mark" aria-hidden="true" style={{ width: 38, height: 38, fontSize: 18 }}>
            ◎
          </span>
          <div style={{ flex: 1 }}>
            <h2 id="setup-title">Setup guide</h2>
            <p>
              {s ? `${done} of ${core.length} core steps done.` : 'Checking this installation…'} Settings live in the <code>.env</code> file in the app folder (copy <code>.env.example</code> to <code>.env</code> if it is missing). After editing it, restart
              the app with <code>stop.bat</code> then <code>start.bat</code>, and press <b>Re-check</b>.
            </p>
            {s && (
              <div className="progress" style={{ maxWidth: 320 }}>
                <i style={{ width: `${(100 * done) / core.length}%` }} />
              </div>
            )}
          </div>
          <button className="ghost" onClick={onClose} aria-label="Close setup guide">
            ✕
          </button>
        </div>

        <div className="modal-body">
          {error && <div className="error">{error}</div>}
          {s && (
            <>
              <div className="guide-group">Get started</div>
              <Step kind="done" title="The app is running" badge={<span className="badge badge-ok">{s.app.queueDriver === 'inline' ? 'Single-process mode' : 'Worker + scheduler mode'}</span>}>
                <p>
                  Database ready. {s.app.queueDriver === 'inline' ? 'Jobs and schedules run inside the app (no Redis needed on one computer).' : 'Jobs run in the background worker.'}
                  {s.app.schedulerPaused && ' Schedules are paused: resume them on the Schedules page.'}
                </p>
              </Step>
              <Step kind={s.data.projects > 0 ? 'done' : 'todo'} title="Create your first project" badge={s.data.projects > 0 ? <span className="badge badge-ok">{s.data.projects} active</span> : undefined}>
                <p>A project groups the market you watch: its platforms, languages, keywords and competitors.</p>
                <div className="step-actions">
                  <a href="#/projects" onClick={go('#/projects')}>
                    Open Projects →
                  </a>
                </div>
              </Step>
              <Step kind={s.data.trackedAccounts > 0 ? 'done' : 'todo'} title="Add competitors" badge={s.data.trackedAccounts > 0 ? <span className="badge badge-ok">{s.data.trackedAccounts} tracked</span> : undefined}>
                <ol>
                  <li>
                    <b>Discover:</b> in a project, add keywords ({s.data.activeKeywords} active now), run discovery, then approve the candidates you want to track.
                  </li>
                  <li>
                    <b>Or add directly:</b> on Accounts, paste a profile URL or handle (for example <code>https://bsky.app/profile/name.bsky.social</code>).
                  </li>
                </ol>
                <div className="step-actions">
                  <a href="#/projects" onClick={go('#/projects')}>
                    Keywords & discovery →
                  </a>
                  <a href="#/accounts" onClick={go('#/accounts')}>
                    Track an account →
                  </a>
                </div>
              </Step>

              <div className="guide-group">Data sources</div>
              <Step kind="done" title="Bluesky" badge={<span className="badge badge-verified">{s.sources.bluesky.enabled ? 'Working, no key needed' : 'Disabled'}</span>}>
                <p>Public profiles, posts and search work without an account.</p>
              </Step>
              <Step kind={s.sources.youtube.apiKeySet ? 'done' : 'todo'} title="YouTube API key" badge={yes(s.sources.youtube.apiKeySet, s.sources.youtube.enabled ? 'Enabled' : 'Key set: verification pending')}>
                <p>The second data source. It is free within Google's daily quota.</p>
                <ol>
                  <li>
                    Open{' '}
                    <a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noopener noreferrer">
                      Google Cloud Console → YouTube Data API v3
                    </a>
                    , create or select a project, then press <b>Enable</b>.
                  </li>
                  <li>
                    Go to <b>APIs & Services → Credentials → Create credentials → API key</b>. Restrict the key to <i>YouTube Data API v3</i>.
                  </li>
                  <li>Add it to <code>.env</code>, then restart:</li>
                </ol>
                <Snippet text="YOUTUBE_API_KEY=paste-your-key-here" />
                <p className="small muted">YouTube switches on after 3 verification runs (`npm run poc -- youtube`), as recorded in ADR-0007.</p>
              </Step>
              <Step kind={s.sources.bluesky.appPasswordSet ? 'done' : 'optional'} title="Bluesky App Password (optional)" badge={yes(s.sources.bluesky.appPasswordSet)}>
                <p>
                  Lets keyword search go past the first page of results. In the Bluesky app: <b>Settings → Privacy and security → App passwords → Add</b>. Use an App Password, never your main password.
                </p>
                <Snippet text={'BLUESKY_IDENTIFIER=yourname.bsky.social\nBLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx'} />
              </Step>

              <div className="guide-group">Optional features</div>
              <Step kind={s.features.ai.anthropicKeySet ? 'done' : 'optional'} title="AI analysis (Claude)" badge={yes(s.features.ai.anthropicKeySet)}>
                <p>
                  Summarises top posts on the Insights page. Create a key at{' '}
                  <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer">
                    console.anthropic.com → API keys
                  </a>
                  .
                </p>
                <Snippet text="ANTHROPIC_API_KEY=sk-ant-..." />
              </Step>
              <Step kind={n && (n.telegram || n.email || n.webhook) ? 'done' : 'optional'} title="Reports by Telegram, email or webhook" badge={<>{yes(!!n?.telegram, 'Telegram on', 'Telegram off')} {yes(!!n?.email, 'Email on', 'Email off')} {yes(!!n?.webhook, 'Webhook on', 'Webhook off')}</>}>
                <ol>
                  <li>
                    <b>Telegram:</b> create a bot with <code>@BotFather</code> to get its token. Send the bot a message, then open <code>https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code> and copy <code>chat.id</code>.
                  </li>
                  <li>
                    <b>Email:</b> an SMTP account (for example a Gmail app password).
                  </li>
                  <li>
                    <b>Webhook:</b> any URL (for example n8n). Payloads are signed with the secret.
                  </li>
                </ol>
                <Snippet text={'TELEGRAM_BOT_TOKEN=123456:ABC...\nTELEGRAM_CHAT_ID=123456789\n# SMTP_URL=smtps://user:app-password@smtp.gmail.com:465\n# EMAIL_FROM=you@example.com\n# EMAIL_TO=you@example.com\n# WEBHOOK_URL=https://example.com/hook\n# WEBHOOK_SECRET=at-least-16-characters'} />
                <div className="step-actions">
                  <a href="#/reports" onClick={go('#/reports')}>
                    Send a test notification on Reports →
                  </a>
                </div>
              </Step>
              <Step kind={s.features.backup.passphraseSet ? 'done' : 'optional'} title="Keep the backup key safe" badge={<span className="badge badge-skipped">{s.features.backup.backups} backup(s)</span>}>
                <p>
                  Backups run daily and are encrypted.{' '}
                  {s.features.backup.passphraseSet ? (
                    'A passphrase is set: keep it somewhere safe.'
                  ) : s.features.backup.keyFileExists ? (
                    <>
                      The key is in <code>.data/backup.key</code>. Copy it somewhere safe (a password manager or a USB stick), or the backups cannot be restored.
                    </>
                  ) : (
                    'A key is created at the first backup; or set a passphrase now:'
                  )}
                </p>
                {!s.features.backup.passphraseSet && <Snippet text="BACKUP_PASSPHRASE=a-long-passphrase-you-will-remember" />}
              </Step>
              <Step kind={s.app.queueDriver === 'bullmq' ? 'done' : 'optional'} title="Background worker (Redis)" badge={yes(s.app.queueDriver === 'bullmq', 'Running', 'Not installed')}>
                <p>Not needed on one computer. With Redis, jobs run in a separate worker and survive restarts better. On Windows:</p>
                <Snippet text="winget install Memurai.MemuraiDeveloper" />
              </Step>
              <Step kind="optional" title="Access from other devices" badge={<span className="badge badge-ok">{s.features.remoteAccess.loopbackOnly ? 'This computer only (safe)' : s.features.remoteAccess.apiTokenSet ? 'Remote, token set' : 'Remote'}</span>}>
                <p>
                  The app only listens on this computer. To open it to a network, set a long <code>API_TOKEN</code> and put HTTPS in front (see <code>docs/DEPLOYMENT.md</code> §3).
                </p>
              </Step>

              <div className="guide-group">Decisions waiting for you</div>
              <Step kind={s.sources.bluesky.policyProposal === 'APPROVED' ? 'done' : 'decision'} title="Bluesky data policy" badge={<span className="badge badge-pending">{s.sources.bluesky.policyProposal ?? 'unknown'}</span>}>
                <p>
                  Until it is approved, history, viral and trend analytics, AI and exports of Bluesky data stay off. To approve, set <code>policyProposal.status</code> to <code>"APPROVED"</code> in <code>docs/feasibility/capabilities/bluesky.json</code> and
                  restart.
                </p>
              </Step>
              <Step kind={s.sources.appleAppStore.policyProposal === 'APPROVED' ? 'done' : 'decision'} title="App Store data policy" badge={<span className="badge badge-pending">{s.sources.appleAppStore.policyProposal ?? 'unknown'}</span>}>
                <p>
                  Approving allows daily rating and version history (365 days) and internal export in App Spy. Edit <code>docs/feasibility/app-stores/apple.json</code>.
                </p>
              </Step>
              <Step kind="decision" title="Ad Spy sources">
                <p>
                  Meta needs a developer app and identity confirmation (EU and political ads only). Google needs a Google Cloud project (BigQuery). TikTok needs legal advice first. Details:{' '}
                  <code>docs/feasibility/ad-spy.md</code>.
                </p>
              </Step>
            </>
          )}
        </div>

        <div className="modal-foot">
          <span className="muted small">{s ? `Checked ${new Date(s.checkedAt).toLocaleTimeString()}` : ''}</span>
          <span style={{ flex: 1 }} />
          <button onClick={onRecheck}>Re-check</button>
          <button className="primary" onClick={onClose}>
            {s && done === core.length ? 'Done' : 'Continue to the app'}
          </button>
        </div>
      </div>
    </div>
  );
}
