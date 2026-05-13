import React, { useState } from 'react';
import type { RunningSession } from '../api/client';

interface Props {
  sessions: RunningSession[];
}

const STATUS_COLOR: Record<string, string> = {
  StreamingTurn: '#22c55e',
  InitializingSession: '#a78bfa',
  LaunchingAgentProcess: '#60a5fa',
  BuildingPrompt: '#f59e0b',
  PreparingWorkspace: '#94a3b8',
  Finishing: '#34d399',
  Stalled: '#ef4444',
  CanceledByReconciliation: '#f97316',
  Failed: '#ef4444',
  TimedOut: '#ef4444',
};

function timeSince(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${(s / 3600).toFixed(1)}h ago`;
}

function StatusBadge({ status }: { status: string }): React.ReactElement {
  const color = STATUS_COLOR[status] ?? '#64748b';
  return (
    <span style={{ color, fontWeight: 600, fontSize: '0.8em' }}>{status}</span>
  );
}

export function RunningList({ sessions }: Props): React.ReactElement {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (sessions.length === 0) {
    return <EmptyState label="No active sessions" />;
  }

  return (
    <div>
      {sessions.map(s => (
        <div key={s.issue_id} style={styles.row}>
          <div
            style={styles.header}
            onClick={() => setExpanded(expanded === s.issue_id ? null : s.issue_id)}
          >
            <div style={styles.headerLeft}>
              <span style={styles.identifier}>{s.issue_identifier}</span>
              <StatusBadge status={s.state} />
            </div>
            <div style={styles.headerRight}>
              <span style={styles.meta}>Turn {s.turn_count}</span>
              <span style={styles.meta}>{timeSince(s.started_at)}</span>
              <span style={styles.meta}>{s.tokens.total_tokens.toLocaleString()} tok</span>
              <span style={styles.chevron}>{expanded === s.issue_id ? '▲' : '▼'}</span>
            </div>
          </div>

          {s.last_message && (
            <div style={styles.lastMsg}>{s.last_message}</div>
          )}

          {expanded === s.issue_id && (
            <div style={styles.detail}>
              <DetailRow label="Session ID" value={s.session_id ?? '-'} />
              <DetailRow label="Last Event" value={s.last_event ?? '-'} />
              {s.last_event_at && <DetailRow label="Event At" value={s.last_event_at} />}
              <DetailRow label="Started" value={s.started_at} />
              <DetailRow label="Input Tokens" value={s.tokens.input_tokens.toLocaleString()} />
              <DetailRow label="Output Tokens" value={s.tokens.output_tokens.toLocaleString()} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div style={{ display: 'flex', gap: '12px', marginBottom: '4px', fontSize: '0.8em' }}>
      <span style={{ color: '#64748b', minWidth: '120px' }}>{label}</span>
      <span style={{ color: '#cbd5e1', wordBreak: 'break-all' }}>{value}</span>
    </div>
  );
}

function EmptyState({ label }: { label: string }): React.ReactElement {
  return (
    <div style={{ textAlign: 'center', color: '#475569', padding: '40px', background: '#1e293b', borderRadius: '12px' }}>
      {label}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    background: '#1e293b',
    borderRadius: '12px',
    marginBottom: '8px',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 20px',
    cursor: 'pointer',
    userSelect: 'none',
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
  },
  identifier: {
    fontWeight: 700,
    color: '#e2e8f0',
    fontSize: '0.95em',
    fontFamily: 'monospace',
  },
  meta: {
    fontSize: '0.8em',
    color: '#64748b',
  },
  chevron: {
    fontSize: '0.7em',
    color: '#475569',
  },
  lastMsg: {
    padding: '0 20px 12px',
    fontSize: '0.8em',
    color: '#94a3b8',
    borderTop: '1px solid #0f172a',
    paddingTop: '10px',
    fontFamily: 'monospace',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  detail: {
    padding: '12px 20px 16px',
    borderTop: '1px solid #0f172a',
    background: '#0f172a',
  },
};
