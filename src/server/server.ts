import * as path from 'path';
import * as fs from 'fs';
import express, { Request, Response, NextFunction } from 'express';
import { Orchestrator } from '../orchestrator/orchestrator';
import { OrchestratorState, RuntimeSnapshot } from '../types';
import { logger } from '../logging/logger';

export class SymphonyServer {
  private app: express.Application;
  private orchestrator: Orchestrator;

  constructor(orchestrator: Orchestrator) {
    this.orchestrator = orchestrator;
    this.app = express();
    this.app.use(express.json());
    this.setupRoutes();
  }

  private buildSnapshot(): RuntimeSnapshot {
    const state = this.orchestrator.getState();

    const running = [...state.running.values()].map(e => ({
      issue_id: e.issue_id,
      issue_identifier: e.identifier,
      session_id: e.session?.session_id ?? null,
      turn_count: e.session?.turn_count ?? 0,
      state: e.state,
      started_at: e.started_at,
      last_event: e.session?.last_codex_event ?? null,
      last_message: e.session?.last_codex_message ?? '',
      last_event_at: e.session?.last_codex_timestamp ?? null,
      tokens: {
        input_tokens: e.session?.codex_input_tokens ?? 0,
        output_tokens: e.session?.codex_output_tokens ?? 0,
        total_tokens: e.session?.codex_total_tokens ?? 0,
      },
    }));

    const retrying = [...state.retry_attempts.values()].map(r => ({
      issue_id: r.issue_id,
      issue_identifier: r.identifier,
      attempt: r.attempt,
      due_at: new Date(r.due_at_ms).toISOString(),
      error: r.error,
    }));

    return {
      running,
      retrying,
      codex_totals: state.codex_totals,
      rate_limits: state.codex_rate_limits,
    };
  }

  private setupRoutes(): void {
    // Serve React client if built
    const clientDist = path.resolve(__dirname, '../../client/dist');
    if (fs.existsSync(clientDist)) {
      this.app.use(express.static(clientDist));
    }

    // GET /api/v1/state
    this.app.get('/api/v1/state', (_req: Request, res: Response) => {
      try {
        const snap = this.buildSnapshot();
        res.json({
          generated_at: new Date().toISOString(),
          counts: { running: snap.running.length, retrying: snap.retrying.length },
          running: snap.running,
          retrying: snap.retrying,
          codex_totals: snap.codex_totals,
          rate_limits: snap.rate_limits,
        });
      } catch (err) {
        res.status(500).json({ error: { code: 'internal_error', message: String(err) } });
      }
    });

    // 405 for wrong methods on /api/v1/state
    this.app.all('/api/v1/state', (_req: Request, res: Response) => {
      res.status(405).json({ error: { code: 'method_not_allowed', message: 'Method not allowed' } });
    });

    // POST /api/v1/refresh
    this.app.post('/api/v1/refresh', (_req: Request, res: Response) => {
      const requestedAt = new Date().toISOString();
      this.orchestrator.triggerPoll();
      res.status(202).json({
        queued: true,
        coalesced: false,
        requested_at: requestedAt,
        operations: ['poll', 'reconcile'],
      });
    });

    // GET /api/v1/:identifier
    this.app.get('/api/v1/:identifier', (req: Request, res: Response) => {
      try {
        const { identifier } = req.params;
        const state = this.orchestrator.getState();

        let runningEntry = null;
        for (const e of state.running.values()) {
          if (e.identifier === identifier) { runningEntry = e; break; }
        }

        let retryEntry = null;
        for (const r of state.retry_attempts.values()) {
          if (r.identifier === identifier) { retryEntry = r; break; }
        }

        const isCompleted = state.completed.has(identifier);
        if (!runningEntry && !retryEntry && !isCompleted) {
          res.status(404).json({
            error: { code: 'issue_not_found', message: `Issue "${identifier}" not found` },
          });
          return;
        }

        const issueId = runningEntry?.issue_id ?? retryEntry?.issue_id ?? identifier;
        const workspacePath = runningEntry
          ? path.join(state.running.get(issueId)?.issue_id ? '' : '', '') // will be set below
          : null;

        res.json({
          issue_identifier: identifier,
          issue_id: issueId,
          status: runningEntry
            ? runningEntry.state
            : retryEntry
            ? 'RetryQueued'
            : 'Completed',
          workspace: runningEntry
            ? { path: `${this.orchestrator.getState().running.get(runningEntry.issue_id)?.issue.identifier}` }
            : null,
          attempts: {
            restart_count: retryEntry?.attempt ?? runningEntry?.retry_attempt ?? 0,
            current_retry_attempt: runningEntry?.retry_attempt ?? null,
          },
          running: runningEntry
            ? {
                session_id: runningEntry.session?.session_id ?? null,
                turn_count: runningEntry.session?.turn_count ?? 0,
                state: runningEntry.state,
                started_at: runningEntry.started_at,
                last_event: runningEntry.session?.last_codex_event ?? null,
                last_message: runningEntry.session?.last_codex_message ?? '',
                last_event_at: runningEntry.session?.last_codex_timestamp ?? null,
                tokens: {
                  input_tokens: runningEntry.session?.codex_input_tokens ?? 0,
                  output_tokens: runningEntry.session?.codex_output_tokens ?? 0,
                  total_tokens: runningEntry.session?.codex_total_tokens ?? 0,
                },
              }
            : null,
          retry: retryEntry
            ? {
                attempt: retryEntry.attempt,
                due_at: new Date(retryEntry.due_at_ms).toISOString(),
                error: retryEntry.error,
              }
            : null,
          logs: { codex_session_logs: [] },
          recent_events: [],
          last_error: retryEntry?.error ?? null,
          tracked: {},
        });
      } catch (err) {
        res.status(500).json({ error: { code: 'internal_error', message: String(err) } });
      }
    });

    // SPA fallback
    const clientDistSpa = path.resolve(__dirname, '../../client/dist');
    const indexHtml = path.join(clientDistSpa, 'index.html');
    if (fs.existsSync(indexHtml)) {
      this.app.get('*', (_req: Request, res: Response) => {
        res.sendFile(indexHtml);
      });
    } else if (!fs.existsSync(clientDist)) {
      // Minimal dashboard when no React build present
      this.app.get('/', (_req: Request, res: Response) => {
        const snap = this.buildSnapshot();
        const html = buildMinimalDashboard(snap);
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
      });
    }
  }

  listen(port: number): Promise<void> {
    return new Promise(resolve => {
      this.app.listen(port, '127.0.0.1', () => {
        logger.info(`HTTP server listening on http://127.0.0.1:${port}`);
        resolve();
      });
    });
  }
}

function buildMinimalDashboard(snap: RuntimeSnapshot): string {
  const runningRows = snap.running.map(r => `
    <tr>
      <td>${esc(r.issue_identifier)}</td>
      <td>${esc(r.state)}</td>
      <td>${esc(r.session_id ?? '-')}</td>
      <td>${r.turn_count}</td>
      <td>${esc(r.last_event ?? '-')}</td>
      <td>${esc(r.last_message.slice(0, 80))}</td>
      <td>${r.tokens.total_tokens.toLocaleString()}</td>
    </tr>`).join('');

  const retryRows = snap.retrying.map(r => `
    <tr>
      <td>${esc(r.issue_identifier)}</td>
      <td>${r.attempt}</td>
      <td>${esc(r.due_at)}</td>
      <td>${esc(r.error ?? '-')}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Symphony Dashboard</title>
  <meta http-equiv="refresh" content="10">
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; background: #0f172a; color: #e2e8f0; }
    h1 { color: #7c3aed; margin: 0 0 4px; }
    .subtitle { color: #64748b; margin: 0 0 32px; font-size: 0.9em; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 32px; }
    .card { background: #1e293b; border-radius: 12px; padding: 20px; }
    .card-label { font-size: 0.75em; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
    .card-value { font-size: 2em; font-weight: 700; color: #7c3aed; margin-top: 4px; }
    h2 { color: #94a3b8; font-size: 1em; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; }
    table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 12px; overflow: hidden; margin-bottom: 32px; }
    th { background: #0f172a; color: #64748b; font-size: 0.75em; text-transform: uppercase; padding: 12px 16px; text-align: left; }
    td { padding: 12px 16px; font-size: 0.875em; border-top: 1px solid #334155; color: #cbd5e1; }
    .empty { text-align: center; color: #475569; padding: 32px; }
    .refresh-btn { background: #7c3aed; color: white; border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer; }
  </style>
</head>
<body>
  <h1>Symphony</h1>
  <p class="subtitle">Coding agent orchestration service &mdash; auto-refreshes every 10s</p>

  <div class="grid">
    <div class="card"><div class="card-label">Running</div><div class="card-value">${snap.running.length}</div></div>
    <div class="card"><div class="card-label">Retrying</div><div class="card-value">${snap.retrying.length}</div></div>
    <div class="card"><div class="card-label">Total Tokens</div><div class="card-value">${snap.codex_totals.total_tokens.toLocaleString()}</div></div>
    <div class="card"><div class="card-label">Runtime (s)</div><div class="card-value">${Math.round(snap.codex_totals.seconds_running).toLocaleString()}</div></div>
  </div>

  <h2>Running Sessions</h2>
  <table>
    <thead><tr><th>Issue</th><th>Status</th><th>Session</th><th>Turns</th><th>Last Event</th><th>Last Message</th><th>Tokens</th></tr></thead>
    <tbody>${runningRows || '<tr><td colspan="7" class="empty">No active sessions</td></tr>'}</tbody>
  </table>

  <h2>Retry Queue</h2>
  <table>
    <thead><tr><th>Issue</th><th>Attempt</th><th>Due At</th><th>Error</th></tr></thead>
    <tbody>${retryRows || '<tr><td colspan="4" class="empty">No retries scheduled</td></tr>'}</tbody>
  </table>

  <button class="refresh-btn" onclick="fetch('/api/v1/refresh',{method:'POST'}).then(()=>location.reload())">Trigger Poll</button>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
