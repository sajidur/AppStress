import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api } from './api';
import { useInterval } from './hooks';
import { RunPage } from './pages/RunPage';
import { RunsPage } from './pages/RunsPage';
import { SystemPage } from './pages/SystemPage';
import { TestPage } from './pages/TestPage';
import { TestsPage } from './pages/TestsPage';
import type { SystemStatus } from './types';

type Theme = 'system' | 'light' | 'dark';

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem('lt-theme') as Theme) || 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('lt-theme', theme);
    } catch {
      /* storage unavailable */
    }
  }, [theme]);
  return [theme, setTheme];
}

function HealthIndicator() {
  const [sys, setSys] = useState<SystemStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const load = () =>
    api
      .system()
      .then((s) => {
        setSys(s);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  useEffect(() => void load(), []);
  useInterval(load, 10_000);
  const ok = !failed && sys?.redis.ok && sys?.rabbitmq.ok;
  const label = sys?.mode === 'memory' ? `In-memory · ${sys.capacity} VUs` : `${sys?.workers.length} worker${sys?.workers.length === 1 ? '' : 's'} · ${sys?.capacity} VUs`;
  return (
    <NavLink to="/system" className="row" style={{ color: 'var(--text-2)', gap: 6 }} title="Infrastructure status">
      <span className={`badge ${ok ? 'good' : 'bad'}`}>
        <span className="dot" />
        {failed ? 'Server offline' : !sys ? '…' : ok ? label : 'Infra issue'}
      </span>
    </NavLink>
  );
}

export function App() {
  const [theme, setTheme] = useTheme();
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-logo" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 32 32">
              <path d="M5 23l7-8 5 4 10-12" stroke="#fff" strokeWidth="3.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          Load Test Studio
        </div>
        <NavLink to="/tests" className="nav-link">
          Tests
        </NavLink>
        <NavLink to="/runs" className="nav-link">
          Run history
        </NavLink>
        <NavLink to="/system" className="nav-link">
          Workers &amp; system
        </NavLink>
        <div className="sidebar-footer">
          <HealthIndicator />
          <select aria-label="Theme" value={theme} onChange={(e) => setTheme(e.target.value as Theme)} style={{ width: 'auto' }}>
            <option value="system">Theme: system</option>
            <option value="light">Theme: light</option>
            <option value="dark">Theme: dark</option>
          </select>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/tests" replace />} />
          <Route path="/tests" element={<TestsPage />} />
          <Route path="/tests/:id/*" element={<TestPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/runs/:id" element={<RunPage />} />
          <Route path="/system" element={<SystemPage />} />
          <Route path="*" element={<div className="page"><h1>Not found</h1></div>} />
        </Routes>
      </main>
    </div>
  );
}
