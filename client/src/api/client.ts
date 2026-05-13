export interface TokenCounts {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface RunningSession {
  issue_id: string;
  issue_identifier: string;
  session_id: string | null;
  turn_count: number;
  state: string;
  started_at: string;
  last_event: string | null;
  last_message: string;
  last_event_at: string | null;
  tokens: TokenCounts;
}

export interface RetryItem {
  issue_id: string;
  issue_identifier: string;
  attempt: number;
  due_at: string;
  error: string | null;
}

export interface CodexTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  seconds_running: number;
}

export interface StateResponse {
  generated_at: string;
  counts: { running: number; retrying: number };
  running: RunningSession[];
  retrying: RetryItem[];
  codex_totals: CodexTotals;
  rate_limits: unknown;
}

export interface IssueDetail {
  issue_identifier: string;
  issue_id: string;
  status: string;
  workspace: { path: string } | null;
  attempts: { restart_count: number; current_retry_attempt: number | null };
  running: {
    session_id: string | null;
    turn_count: number;
    state: string;
    started_at: string;
    last_event: string | null;
    last_message: string;
    last_event_at: string | null;
    tokens: TokenCounts;
  } | null;
  retry: { attempt: number; due_at: string; error: string | null } | null;
  last_error: string | null;
}

export async function fetchState(): Promise<StateResponse> {
  const res = await fetch('/api/v1/state');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<StateResponse>;
}

export async function fetchIssue(identifier: string): Promise<IssueDetail> {
  const res = await fetch(`/api/v1/${encodeURIComponent(identifier)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<IssueDetail>;
}

export async function triggerRefresh(): Promise<void> {
  await fetch('/api/v1/refresh', { method: 'POST' });
}
