import React from 'react';
import type { CodexTotals } from '../api/client';

interface Props {
  totals: CodexTotals;
  running: number;
  retrying: number;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

function fmtTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

export function TokenTotals({ totals, running, retrying }: Props): React.ReactElement {
  const cards = [
    { label: 'Running', value: String(running), accent: true },
    { label: 'Retrying', value: String(retrying), accent: false },
    { label: 'Input Tokens', value: fmt(totals.input_tokens), accent: false },
    { label: 'Output Tokens', value: fmt(totals.output_tokens), accent: false },
    { label: 'Total Tokens', value: fmt(totals.total_tokens), accent: true },
    { label: 'Agent Runtime', value: fmtTime(totals.seconds_running), accent: false },
  ];

  return (
    <div style={styles.grid}>
      {cards.map(c => (
        <div key={c.label} style={styles.card}>
          <div style={styles.label}>{c.label}</div>
          <div style={{ ...styles.value, color: c.accent ? '#a78bfa' : '#e2e8f0' }}>{c.value}</div>
        </div>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
    gap: '16px',
    marginBottom: '32px',
  },
  card: {
    background: '#1e293b',
    borderRadius: '12px',
    padding: '20px 16px',
  },
  label: {
    fontSize: '0.72em',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: '0.07em',
    fontWeight: 600,
  },
  value: {
    fontSize: '1.8em',
    fontWeight: 700,
    marginTop: '6px',
  },
};
