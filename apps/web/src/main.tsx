import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AccountPage, Accounts } from './pages/Accounts.tsx';
import { AppPage, Apps } from './pages/Apps.tsx';
import { Builder } from './pages/Builder.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { Explorer } from './pages/Explorer.tsx';
import { Insights } from './pages/Insights.tsx';
import { Exports, Jobs, Sources, Workflows } from './pages/Ops.tsx';
import { ProjectPage, Projects } from './pages/Projects.tsx';
import { Reports } from './pages/Reports.tsx';
import { guideSeen, markGuideSeen, SetupGuide, useSetupStatus } from './SetupGuide.tsx';
import { Icon, type IconName } from './icons.tsx';
import './styles.css';

/*
 * Phase 5 web UI (Master Plan §10): Dashboard, Projects (keywords, discovery, review queue), Accounts,
 * Content Explorer with server-side filters + exports, Job Monitor, Automations, Exports, Data Sources.
 * Hash routing keeps the app a static bundle served by the API (no server-side routing needed).
 */

type Route =
  | { page: 'dashboard' }
  | { page: 'projects' }
  | { page: 'project'; id: string }
  | { page: 'accounts' }
  | { page: 'account'; id: string }
  | { page: 'explore' }
  | { page: 'insights' }
  | { page: 'jobs' }
  | { page: 'workflows' }
  | { page: 'builder'; id?: string }
  | { page: 'apps' }
  | { page: 'app'; id: string }
  | { page: 'exports' }
  | { page: 'reports' }
  | { page: 'sources' };

const SIMPLE = ['projects', 'accounts', 'explore', 'insights', 'apps', 'jobs', 'workflows', 'exports', 'reports', 'sources'] as const;

function parseHash(): Route {
  const [path] = location.hash.replace(/^#\/?/, '').split('?');
  const [page, id] = (path ?? '').split('/');
  if ((page === 'account' || page === 'project' || page === 'app') && id) return { page, id };
  if (page === 'builder') return id ? { page, id } : { page };
  if ((SIMPLE as readonly string[]).includes(page ?? '')) return { page: page as (typeof SIMPLE)[number] };
  return { page: 'dashboard' };
}

const NAV: { group: string; items: [string, string, IconName, string[]][] }[] = [
  { group: 'Overview', items: [['dashboard', 'Dashboard', 'dashboard', []]] },
  {
    group: 'Research',
    items: [
      ['projects', 'Projects', 'folder', ['project']],
      ['accounts', 'Accounts', 'users', ['account']],
      ['explore', 'Content Explorer', 'search', []],
      ['insights', 'Insights', 'trend', []],
      ['apps', 'App Spy', 'phone', ['app']],
    ],
  },
  {
    group: 'Automation',
    items: [
      ['builder', 'Workflow Builder', 'workflow', []],
      ['workflows', 'Schedules', 'clock', []],
      ['jobs', 'Job Monitor', 'activity', []],
    ],
  },
  {
    group: 'Output',
    items: [
      ['exports', 'Exports', 'download', []],
      ['reports', 'Reports', 'file', []],
    ],
  },
  { group: 'System', items: [['sources', 'Data Sources', 'database', []]] },
];

function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [key, setKey] = useState(0);
  useEffect(() => {
    const on = () => {
      setRoute(parseHash());
      setKey((k) => k + 1);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const [guideOpen, setGuideOpen] = useState(false);
  const setup = useSetupStatus();
  // First visit: open the setup guide once.
  useEffect(() => {
    if (!guideSeen()) setGuideOpen(true);
  }, []);
  const isActive = (p: string, also: string[]) => route.page === p || also.includes(route.page);
  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Main navigation">
        <a className="brand" href="#/dashboard">
          <span className="brand-mark" aria-hidden="true">
            ◎
          </span>
          <span>
            Social Spy
            <small>Competitor intelligence</small>
          </span>
        </a>
        {NAV.map((g) => (
          <div key={g.group} style={{ display: 'contents' }}>
            <div className="nav-group">{g.group}</div>
            {g.items.map(([p, label, icon, also]) => (
              <a key={p} href={`#/${p}`} className={`nav-link${isActive(p, also) ? ' active' : ''}`} aria-current={isActive(p, also) ? 'page' : undefined}>
                <Icon name={icon} />
                {label}
              </a>
            ))}
          </div>
        ))}
        <a className="nav-link" href="/api/docs" target="_blank" rel="noopener noreferrer">
          <Icon name="code" />
          API docs
        </a>
        <div className="sidebar-foot">
          <button className="setup-card" onClick={() => setGuideOpen(true)}>
            <b>
              Setup guide <span style={{ margin: 0 }}>{setup.data ? `${setup.done}/${setup.total}` : ''}</span>
            </b>
            <span>{setup.data ? (setup.done === setup.total ? 'Core setup complete' : 'Finish setting up') : 'Keys, sources, reports'}</span>
            <div className="progress" aria-hidden="true">
              <i style={{ width: `${setup.data ? (100 * setup.done) / setup.total : 0}%` }} />
            </div>
          </button>
        </div>
      </aside>
      {guideOpen && (
        <SetupGuide
          status={setup.data}
          error={setup.error}
          onRecheck={setup.reload}
          onClose={() => {
            markGuideSeen();
            setGuideOpen(false);
            setup.reload();
          }}
        />
      )}
      <main key={key}>
        {route.page === 'dashboard' && <Dashboard />}
        {route.page === 'projects' && <Projects />}
        {route.page === 'project' && <ProjectPage id={route.id} />}
        {route.page === 'accounts' && <Accounts />}
        {route.page === 'account' && <AccountPage id={route.id} />}
        {route.page === 'explore' && <Explorer />}
        {route.page === 'insights' && <Insights />}
        {route.page === 'apps' && <Apps />}
        {route.page === 'app' && <AppPage id={route.id} />}
        {route.page === 'jobs' && <Jobs />}
        {route.page === 'workflows' && <Workflows />}
        {route.page === 'builder' && <Builder id={route.id} />}
        {route.page === 'exports' && <Exports />}
        {route.page === 'reports' && <Reports />}
        {route.page === 'sources' && <Sources />}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
