import React from 'react';
import type { RetryItem } from '../api/client';

interface Props {
  items: RetryItem[];
}

function timeUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'now';
  const s = Math.ceil(diff / 1000);
  if (s < 60) return `in ${s}s`;
  return `in ${Math.ceil(s / 60)}m`;
}

export function RetryQueue({ items }: Props): React.ReactElement {
  if (items.length === 0) {
    return (
      <div style={{ textAlign: 'center', color: '#475569', padding: '40px', background: '#1e293b', borderRadius: '12px' }}>
        No retries scheduled
      </div>
    );
  }

  return (
    <div>
      {items.map(item => (
        <div key={item.issue_id} style={styles.row}>
          <div style={styles.left}>
            <span style={styles.identifier}>{item.issue_identifier}</span>
            <span style={styles.attempt}>Attempt #{item.attempt}</span>
          </div>
          <div style={styles.right}>
            {item.error && (
              <span style={styles.error}>{item.error.slice(0, 60)}</span>
            )}
            <span style={styles.dueAt}>{timeUntil(item.due_at)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    background: '#1e293b',
    borderRadius: '10px',
    padding: '14px 20px',
    marginBottom: '8px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  left: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  right: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  identifier: {
    fontWeight: 700,
    color: '#e2e8f0',
    fontSize: '0.95em',
    fontFamily: 'monospace',
  },
  attempt: {
    fontSize: '0.75em',
    color: '#64748b',
    background: '#0f172a',
    padding: '2px 8px',
    borderRadius: '4px',
  },
  error: {
    fontSize: '0.75em',
    color: '#f87171',
    maxWidth: '300px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  dueAt: {
    fontSize: '0.8em',
    color: '#a78bfa',
    fontWeight: 600,
    minWidth: '60px',
    textAlign: 'right',
  },
};
