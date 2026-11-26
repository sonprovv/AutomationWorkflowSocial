import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AccountPage, Accounts } from './pages/Accounts.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { Explorer } from './pages/Explorer.tsx';
import { Exports, Jobs, Sources, Workflows } from './pages/Ops.tsx';
import { ProjectPage, Projects } from './pages/Projects.tsx';
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
  | { page: 'jobs' }
  | { page: 'workflows' }
  | { page: 'exports' }
  | { page: 'sources' };

const SIMPLE = ['projects', 'accounts', 'explore', 'jobs', 'workflows', 'exports', 'sources'] as const;

function parseHash(): Route {
  const [path] = location.hash.replace(/^#\/?/, '').split('?');
  const [page, id] = (path ?? '').split('/');
  if ((page === 'account' || page === 'project') && id) return { page, id };
  if ((SIMPLE as readonly string[]).includes(page ?? '')) return { page: page as (typeof SIMPLE)[number] };
  return { page: 'dashboard' };
}

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
  const nav: [string, string, string[]][] = [
    ['dashboard', 'Dashboard', []],
    ['projects', 'Projects', ['project']],
    ['accounts', 'Accounts', ['account']],
    ['explore', 'Content Explorer', []],
    ['jobs', 'Job Monitor', []],
    ['workflows', 'Automations', []],
    ['exports', 'Exports', []],
    ['sources', 'Data Sources', []],
  ];
  return (
    <>
      <header>
        <b>Social Spy Automation</b>
        <nav>
          {nav.map(([p, label, also]) => (
            <a key={p} href={`#/${p}`} className={route.page === p || also.includes(route.page) ? 'active' : ''}>
              {label}
            </a>
          ))}
          <a href="/api/docs" target="_blank" rel="noopener noreferrer">
            API docs
          </a>
        </nav>
      </header>
      <main key={key}>
        {route.page === 'dashboard' && <Dashboard />}
        {route.page === 'projects' && <Projects />}
        {route.page === 'project' && <ProjectPage id={route.id} />}
        {route.page === 'accounts' && <Accounts />}
        {route.page === 'account' && <AccountPage id={route.id} />}
        {route.page === 'explore' && <Explorer />}
        {route.page === 'jobs' && <Jobs />}
        {route.page === 'workflows' && <Workflows />}
        {route.page === 'exports' && <Exports />}
        {route.page === 'sources' && <Sources />}
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
