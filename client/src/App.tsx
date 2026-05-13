import React, { useState, useEffect, useCallback } from 'react';
import { fetchState, triggerRefresh } from './api/client';
import type { StateResponse } from './api/client';
import { TokenTotals } from './components/TokenTotals';
import { RunningList } from './components/RunningList';
import { RetryQueue } from './components/RetryQueue';

const POLL_INTERVAL_MS = 5000;

function useStatePolling() {
  const [data, setData] = useState<StateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const state = await fetchState();
      setData(state);
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  return { data, error, loading, lastUpdated, refresh: load };
}

export default function App(): React.ReactElement {
  const { data, error, loading, lastUpdated, refresh } = useStatePolling();
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await triggerRefresh();
      await refresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div style={styles.root}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>Symphony</h1>
          <p style={styles.subtitle}>Coding agent orchestration</p>
        </div>
        <div style={styles.headerRight}>
          {lastUpdated && (
            <span style={styles.lastUpdated}>
              Updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <button
            style={styles.btn}
            onClick={handleRefresh}
            disabled={refreshing}
          >
            {refreshing ? 'Polling…' : 'Trigger Poll'}
          </button>
        </div>
      </header>

      {loading && !data && (
        <div style={styles.loading}>Connecting to Symphony…</div>
      )}

      {error && (
        <div style={styles.errorBanner}>
          {error} — make sure Symphony is running with --port
        </div>
      )}

      {data && (
        <>
          <TokenTotals
            totals={data.codex_totals}
            running={data.counts.running}
            retrying={data.counts.retrying}
          />

          <Section title="Running Sessions" count={data.counts.running}>
            <RunningList sessions={data.running} />
          </Section>

          <Section title="Retry Queue" count={data.counts.retrying}>
            <RetryQueue items={data.retrying} />
          </Section>
        </>
      )}
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div style={styles.section}>
      <div style={styles.sectionHeader}>
        <h2 style={styles.sectionTitle}>{title}</h2>
        <span style={styles.badge}>{count}</span>
      </div>
      {children}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    fontFamily: 'system-ui, -apple-system, sans-serif',
    background: '#0f172a',
    minHeight: '100vh',
    color: '#e2e8f0',
    padding: '24px',
    maxWidth: '1100px',
    margin: '0 auto',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: '32px',
  },
  title: {
    margin: 0,
    fontSize: '1.8em',
    fontWeight: 800,
    background: 'linear-gradient(135deg, #a78bfa, #60a5fa)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
  },
  subtitle: {
    margin: '4px 0 0',
    color: '#475569',
    fontSize: '0.875em',
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
  },
  lastUpdated: {
    fontSize: '0.8em',
    color: '#475569',
  },
  btn: {
    background: 'linear-gradient(135deg, #7c3aed, #4f46e5)',
    color: 'white',
    border: 'none',
    padding: '10px 20px',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '0.875em',
    fontWeight: 600,
    transition: 'opacity 0.2s',
  },
  loading: {
    textAlign: 'center',
    color: '#475569',
    padding: '80px',
    fontSize: '1.1em',
  },
  errorBanner: {
    background: '#450a0a',
    border: '1px solid #7f1d1d',
    color: '#fca5a5',
    borderRadius: '8px',
    padding: '12px 16px',
    marginBottom: '24px',
    fontSize: '0.875em',
  },
  section: {
    marginBottom: '32px',
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    marginBottom: '12px',
  },
  sectionTitle: {
    margin: 0,
    fontSize: '0.8em',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: '#64748b',
  },
  badge: {
    background: '#1e293b',
    color: '#94a3b8',
    fontSize: '0.75em',
    fontWeight: 700,
    padding: '2px 8px',
    borderRadius: '999px',
  },
};
