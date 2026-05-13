import {
  OrchestratorState,
  Issue,
  RunningEntry,
  RetryEntry,
  WorkflowDefinition,
  LiveSession,
  RunAttemptStatus,
} from '../types';
import { LinearTrackerClient } from '../tracker/linear';
import { WorkspaceManager } from '../workspace/manager';
import { AgentRunner } from '../agent/runner';
import { renderPrompt } from '../config/prompt';
import { logger } from '../logging/logger';

const CONTINUATION_DELAY_MS = 1000;

export type Observer = (state: OrchestratorState) => void;

export class Orchestrator {
  private state: OrchestratorState;
  private workflow: WorkflowDefinition;
  private tracker: LinearTrackerClient;
  private workspaceManager: WorkspaceManager;
  private observers: Observer[] = [];
  private tickTimer: NodeJS.Timeout | null = null;
  private retryTimers: Map<string, NodeJS.Timeout> = new Map();
  private isRunning = false;

  constructor(workflow: WorkflowDefinition) {
    this.workflow = workflow;
    const cfg = workflow.config;

    this.tracker = new LinearTrackerClient(cfg.tracker);
    this.workspaceManager = new WorkspaceManager(cfg.workspace, cfg.hooks);

    this.state = {
      poll_interval_ms: cfg.polling.interval_ms,
      max_concurrent_agents: cfg.agent.max_concurrent_agents,
      running: new Map(),
      claimed: new Set(),
      retry_attempts: new Map(),
      completed: new Set(),
      codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
      codex_rate_limits: null,
    };
  }

  updateWorkflow(workflow: WorkflowDefinition): void {
    this.workflow = workflow;
    const cfg = workflow.config;
    this.tracker = new LinearTrackerClient(cfg.tracker);
    this.workspaceManager = new WorkspaceManager(cfg.workspace, cfg.hooks);
    this.state.poll_interval_ms = cfg.polling.interval_ms;
    this.state.max_concurrent_agents = cfg.agent.max_concurrent_agents;
    logger.info('Orchestrator: workflow reloaded');
    this.notifyObservers();
  }

  addObserver(obs: Observer): void {
    this.observers.push(obs);
  }

  getState(): OrchestratorState {
    return this.state;
  }

  async start(): Promise<void> {
    this.isRunning = true;
    logger.info('Orchestrator starting');
    await this.startupTerminalCleanup();
    this.scheduleTick(0);
  }

  stop(): void {
    this.isRunning = false;
    if (this.tickTimer) { clearTimeout(this.tickTimer); this.tickTimer = null; }
    for (const t of this.retryTimers.values()) clearTimeout(t);
    this.retryTimers.clear();
    for (const entry of this.state.running.values()) {
      entry.abort_controller.abort();
    }
    logger.info('Orchestrator stopped');
  }

  triggerPoll(): void {
    if (this.tickTimer) { clearTimeout(this.tickTimer); this.tickTimer = null; }
    this.scheduleTick(0);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private scheduleTick(delayMs: number): void {
    if (!this.isRunning) return;
    this.tickTimer = setTimeout(() => { this.tick().catch(err => logger.error('Tick error', { error: String(err) })); }, delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.isRunning) return;

    try {
      await this.reconcileRunningIssues();

      const errors = this.validateDispatchConfig();
      if (errors.length > 0) {
        logger.error('Dispatch preflight failed', { errors: errors.join('; ') });
        this.notifyObservers();
        this.scheduleTick(this.state.poll_interval_ms);
        return;
      }

      let candidates: Issue[];
      try {
        candidates = await this.tracker.fetchCandidateIssues();
      } catch (err) {
        logger.error('Failed to fetch candidates, skipping dispatch', { error: String(err) });
        this.notifyObservers();
        this.scheduleTick(this.state.poll_interval_ms);
        return;
      }

      const sorted = this.sortForDispatch(candidates);
      for (const issue of sorted) {
        if (!this.hasSlots()) break;
        if (this.isEligible(issue, candidates)) {
          this.dispatchIssue(issue, null);
        }
      }
    } catch (err) {
      logger.error('Unexpected tick error', { error: String(err) });
    }

    this.notifyObservers();
    this.scheduleTick(this.state.poll_interval_ms);
  }

  private validateDispatchConfig(): string[] {
    const cfg = this.workflow.config;
    const errs: string[] = [];
    if (!cfg.tracker.kind) errs.push('tracker.kind missing');
    else if (cfg.tracker.kind !== 'linear') errs.push('unsupported tracker kind');
    if (!cfg.tracker.api_key) errs.push('tracker.api_key missing');
    if (!cfg.tracker.project_slug) errs.push('tracker.project_slug missing');
    if (!cfg.codex.command) errs.push('codex.command missing');
    return errs;
  }

  private async startupTerminalCleanup(): Promise<void> {
    const cfg = this.workflow.config;
    try {
      const terminalIssues = await this.tracker.fetchIssuesByStates(cfg.tracker.terminal_states);
      for (const issue of terminalIssues) {
        try {
          await this.workspaceManager.removeWorkspace(issue.identifier);
        } catch (err) {
          logger.warn('Startup cleanup: failed to remove workspace', {
            issue_identifier: issue.identifier,
            error: String(err),
          });
        }
      }
      logger.info('Startup terminal workspace cleanup complete');
    } catch (err) {
      logger.warn('Startup terminal cleanup failed (continuing)', { error: String(err) });
    }
  }

  private async reconcileRunningIssues(): Promise<void> {
    const cfg = this.workflow.config;

    // Part A: stall detection
    if (cfg.codex.stall_timeout_ms > 0) {
      for (const [issueId, entry] of this.state.running) {
        const lastTs = entry.session?.last_codex_timestamp ?? entry.started_at;
        const elapsed = Date.now() - new Date(lastTs).getTime();
        if (elapsed > cfg.codex.stall_timeout_ms) {
          logger.warn('Stall detected, aborting worker', {
            issue_id: issueId,
            issue_identifier: entry.identifier,
            elapsed_ms: elapsed,
          });
          entry.state = 'Stalled';
          entry.abort_controller.abort();
        }
      }
    }

    // Part B: tracker state refresh
    const runningIds = [...this.state.running.keys()];
    if (runningIds.length === 0) return;

    let refreshed: Issue[];
    try {
      refreshed = await this.tracker.fetchIssueStatesByIds(runningIds);
    } catch (err) {
      logger.debug('Reconciliation: state refresh failed, keeping workers running', { error: String(err) });
      return;
    }

    const terminalLower = cfg.tracker.terminal_states.map(s => s.toLowerCase());
    const activeLower = cfg.tracker.active_states.map(s => s.toLowerCase());

    for (const issue of refreshed) {
      const stateLower = issue.state.toLowerCase();
      if (terminalLower.includes(stateLower)) {
        this.terminateRunning(issue.id, true, 'CanceledByReconciliation');
      } else if (activeLower.includes(stateLower)) {
        const entry = this.state.running.get(issue.id);
        if (entry) entry.issue = issue;
      } else {
        this.terminateRunning(issue.id, false, 'CanceledByReconciliation');
      }
    }
  }

  private terminateRunning(issueId: string, cleanWorkspace: boolean, status: RunAttemptStatus): void {
    const entry = this.state.running.get(issueId);
    if (!entry) return;

    logger.info('Terminating running issue', {
      issue_id: issueId,
      issue_identifier: entry.identifier,
      status,
      clean_workspace: cleanWorkspace,
    });

    entry.state = status;
    entry.abort_controller.abort();

    if (cleanWorkspace) {
      this.workspaceManager.removeWorkspace(entry.identifier).catch(err => {
        logger.warn('Failed to remove workspace on termination', {
          issue_identifier: entry.identifier,
          error: String(err),
        });
      });
    }
  }

  private sortForDispatch(issues: Issue[]): Issue[] {
    return [...issues].sort((a, b) => {
      const pa = a.priority ?? Infinity;
      const pb = b.priority ?? Infinity;
      if (pa !== pb) return pa - pb;

      const ca = a.created_at ? new Date(a.created_at).getTime() : Infinity;
      const cb = b.created_at ? new Date(b.created_at).getTime() : Infinity;
      if (ca !== cb) return ca - cb;

      return a.identifier.localeCompare(b.identifier);
    });
  }

  private hasSlots(): boolean {
    return this.state.running.size < this.state.max_concurrent_agents;
  }

  private isEligible(issue: Issue, allCandidates: Issue[]): boolean {
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;

    const cfg = this.workflow.config;
    const sl = issue.state.toLowerCase();
    const activeLower = cfg.tracker.active_states.map(s => s.toLowerCase());
    const terminalLower = cfg.tracker.terminal_states.map(s => s.toLowerCase());

    if (!activeLower.includes(sl)) return false;
    if (terminalLower.includes(sl)) return false;
    if (this.state.running.has(issue.id)) return false;
    if (this.state.claimed.has(issue.id)) return false;

    // Per-state concurrency
    const perStateLimit = cfg.agent.max_concurrent_agents_by_state[sl];
    if (perStateLimit !== undefined) {
      const countInState = [...this.state.running.values()].filter(
        e => e.issue.state.toLowerCase() === sl,
      ).length;
      if (countInState >= perStateLimit) return false;
    }

    // Todo blocker rule
    if (sl === 'todo') {
      const candidateIds = new Set(allCandidates.map(c => c.id));
      const hasNonTerminalBlocker = issue.blocked_by.some(b => {
        if (!b.state) return false;
        const bsl = b.state.toLowerCase();
        return !terminalLower.includes(bsl);
      });
      if (hasNonTerminalBlocker) return false;
    }

    return true;
  }

  private dispatchIssue(issue: Issue, attempt: number | null): void {
    const abort = new AbortController();

    const promise = this.runWorker(issue, attempt, abort.signal)
      .then(() => this.onWorkerExit(issue.id, 'normal'))
      .catch(err => this.onWorkerExit(issue.id, String(err)));

    const entry: RunningEntry = {
      issue_id: issue.id,
      identifier: issue.identifier,
      issue,
      session: null,
      retry_attempt: attempt,
      started_at: new Date().toISOString(),
      state: 'PreparingWorkspace',
      worker_promise: promise,
      abort_controller: abort,
    };

    this.state.running.set(issue.id, entry);
    this.state.claimed.add(issue.id);
    this.state.retry_attempts.delete(issue.id);

    logger.info('Issue dispatched', {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      attempt: attempt ?? 0,
    });
  }

  private setEntryState(issueId: string, status: RunAttemptStatus): void {
    const e = this.state.running.get(issueId);
    if (e) e.state = status;
  }

  private async runWorker(
    issue: Issue,
    attempt: number | null,
    signal: AbortSignal,
  ): Promise<void> {
    const cfg = this.workflow.config;

    // Prepare workspace
    this.setEntryState(issue.id, 'PreparingWorkspace');
    let workspace;
    try {
      workspace = await this.workspaceManager.createForIssue(issue.identifier);
    } catch (err) {
      throw new Error(`workspace_error: ${err}`);
    }

    if (signal.aborted) return;

    // before_run hook
    try {
      await this.workspaceManager.runBeforeRun(workspace.path);
    } catch (err) {
      await this.workspaceManager.runAfterRun(workspace.path).catch(() => {});
      throw new Error(`before_run_hook_error: ${err}`);
    }

    if (signal.aborted) {
      await this.workspaceManager.runAfterRun(workspace.path).catch(() => {});
      return;
    }

    // Launch agent
    this.setEntryState(issue.id, 'LaunchingAgentProcess');
    const runner = new AgentRunner(cfg.codex);
    let sessionInfo: { thread_id: string; pid: string };

    try {
      sessionInfo = await runner.start(workspace.path);
    } catch (err) {
      await this.workspaceManager.runAfterRun(workspace.path).catch(() => {});
      throw new Error(`agent_startup_error: ${err}`);
    }

    this.setEntryState(issue.id, 'InitializingSession');

    const session: LiveSession = {
      session_id: `${sessionInfo.thread_id}-turn-0`,
      thread_id: sessionInfo.thread_id,
      turn_id: 'turn-0',
      codex_app_server_pid: sessionInfo.pid,
      last_codex_event: null,
      last_codex_timestamp: null,
      last_codex_message: '',
      codex_input_tokens: 0,
      codex_output_tokens: 0,
      codex_total_tokens: 0,
      last_reported_input_tokens: 0,
      last_reported_output_tokens: 0,
      last_reported_total_tokens: 0,
      turn_count: 0,
    };

    const entry = this.state.running.get(issue.id);
    if (entry) entry.session = session;

    logger.info('Agent session started', {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      session_id: session.session_id,
    });

    let currentIssue = issue;
    const maxTurns = cfg.agent.max_turns;

    for (let turnNum = 1; turnNum <= maxTurns; turnNum++) {
      if (signal.aborted) break;

      this.setEntryState(issue.id, 'BuildingPrompt');
      let prompt: string;
      try {
        prompt = renderPrompt(this.workflow.prompt_template, currentIssue, attempt);
      } catch (err) {
        runner.cleanup();
        await this.workspaceManager.runAfterRun(workspace.path).catch(() => {});
        throw new Error(`prompt_error: ${err}`);
      }

      session.turn_count = turnNum;
      session.turn_id = `turn-${turnNum}`;
      session.session_id = `${session.thread_id}-${session.turn_id}`;
      if (entry) entry.session = { ...session };

      this.setEntryState(issue.id, 'StreamingTurn');
      const turnResult = await runner.runTurn(
        prompt,
        currentIssue,
        attempt,
        {
          onEvent: evt => {
            const e = this.state.running.get(issue.id);
            if (e?.session) {
              e.session.last_codex_event = evt.event;
              e.session.last_codex_timestamp = evt.timestamp;
              if (evt.message) e.session.last_codex_message = evt.message.slice(0, 500);
            }
            if (evt.data && typeof evt.data === 'object') {
              const d = evt.data as Record<string, unknown>;
              if (d['rate_limits']) this.state.codex_rate_limits = d['rate_limits'] as object;
            }
            this.notifyObservers();
          },
          onSessionUpdate: update => {
            const e = this.state.running.get(issue.id);
            if (!e?.session) return;
            Object.assign(e.session, update);
            // Accumulate token deltas
            if (update.codex_input_tokens !== undefined) {
              const delta = update.codex_input_tokens - e.session.last_reported_input_tokens;
              if (delta > 0) {
                this.state.codex_totals.input_tokens += delta;
                e.session.last_reported_input_tokens = update.codex_input_tokens;
              }
            }
            if (update.codex_output_tokens !== undefined) {
              const delta = update.codex_output_tokens - e.session.last_reported_output_tokens;
              if (delta > 0) {
                this.state.codex_totals.output_tokens += delta;
                e.session.last_reported_output_tokens = update.codex_output_tokens;
              }
            }
            if (update.codex_total_tokens !== undefined) {
              const delta = update.codex_total_tokens - e.session.last_reported_total_tokens;
              if (delta > 0) {
                this.state.codex_totals.total_tokens += delta;
                e.session.last_reported_total_tokens = update.codex_total_tokens;
              }
            }
          },
        },
        signal,
        cfg.tracker.kind === 'linear'
          ? (q, vars) => this.tracker.executeGraphQL(q, vars)
          : undefined,
      );

      logger.info('Turn completed', {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        session_id: session.session_id,
        turn: turnNum,
        status: turnResult.status,
      });

      if (turnResult.status !== 'completed') {
        runner.cleanup();
        await this.workspaceManager.runAfterRun(workspace.path).catch(() => {});
        throw new Error(`turn_error: ${turnResult.status}: ${turnResult.error ?? ''}`);
      }

      // Refresh issue state after turn
      let refreshed: Issue[] = [];
      try {
        refreshed = await this.tracker.fetchIssueStatesByIds([issue.id]);
      } catch (err) {
        runner.cleanup();
        await this.workspaceManager.runAfterRun(workspace.path).catch(() => {});
        throw new Error(`state_refresh_error: ${err}`);
      }

      if (refreshed.length > 0) {
        currentIssue = refreshed[0];
        const e = this.state.running.get(issue.id);
        if (e) e.issue = currentIssue;
      }

      const stillActive = cfg.tracker.active_states
        .map(s => s.toLowerCase())
        .includes(currentIssue.state.toLowerCase());

      if (!stillActive) break;
      if (signal.aborted) break;
    }

    this.setEntryState(issue.id, 'Finishing');
    runner.cleanup();
    await this.workspaceManager.runAfterRun(workspace.path).catch(() => {});
  }

  private onWorkerExit(issueId: string, reason: string): void {
    const entry = this.state.running.get(issueId);
    if (!entry) return;

    const elapsed = (Date.now() - new Date(entry.started_at).getTime()) / 1000;
    this.state.codex_totals.seconds_running += elapsed;
    this.state.running.delete(issueId);

    logger.info('Worker exited', {
      issue_id: issueId,
      issue_identifier: entry.identifier,
      reason: reason === 'normal' ? 'normal' : 'failure',
    });

    if (reason === 'normal') {
      this.state.completed.add(issueId);
      this.scheduleRetry(issueId, 1, entry.identifier, null, 'continuation');
    } else {
      const nextAttempt = (entry.retry_attempt ?? 0) + 1;
      this.scheduleRetry(issueId, nextAttempt, entry.identifier, reason, 'failure');
    }

    this.notifyObservers();
  }

  private scheduleRetry(
    issueId: string,
    attempt: number,
    identifier: string,
    error: string | null,
    kind: 'continuation' | 'failure',
  ): void {
    const cfg = this.workflow.config;
    const delayMs =
      kind === 'continuation'
        ? CONTINUATION_DELAY_MS
        : Math.min(10000 * Math.pow(2, attempt - 1), cfg.agent.max_retry_backoff_ms);

    const existing = this.retryTimers.get(issueId);
    if (existing) clearTimeout(existing);

    const entry: RetryEntry = {
      issue_id: issueId,
      identifier,
      attempt,
      due_at_ms: Date.now() + delayMs,
      error,
    };
    this.state.retry_attempts.set(issueId, entry);

    const timer = setTimeout(() => {
      this.retryTimers.delete(issueId);
      this.onRetryTimer(issueId).catch(err =>
        logger.error('Retry timer error', { issue_id: issueId, error: String(err) }),
      );
    }, delayMs);

    this.retryTimers.set(issueId, timer);

    logger.info('Retry scheduled', {
      issue_id: issueId,
      issue_identifier: identifier,
      attempt,
      delay_ms: delayMs,
    });
  }

  private async onRetryTimer(issueId: string): Promise<void> {
    const retryEntry = this.state.retry_attempts.get(issueId);
    if (!retryEntry) return;

    this.state.retry_attempts.delete(issueId);

    let candidates: Issue[];
    try {
      candidates = await this.tracker.fetchCandidateIssues();
    } catch (err) {
      logger.error('Retry: failed to fetch candidates, re-queuing', { issue_id: issueId, error: String(err) });
      this.scheduleRetry(issueId, retryEntry.attempt + 1, retryEntry.identifier, 'retry_poll_failed', 'failure');
      return;
    }

    const issue = candidates.find(c => c.id === issueId);
    if (!issue) {
      this.state.claimed.delete(issueId);
      logger.info('Retry: issue no longer a candidate, releasing', { issue_id: issueId });
      this.notifyObservers();
      return;
    }

    if (!this.hasSlots()) {
      logger.info('Retry: no slots available, re-queuing', { issue_id: issueId });
      this.scheduleRetry(issueId, retryEntry.attempt + 1, issue.identifier, 'no_slots', 'failure');
      this.notifyObservers();
      return;
    }

    this.dispatchIssue(issue, retryEntry.attempt);
    this.notifyObservers();
  }

  private notifyObservers(): void {
    for (const obs of this.observers) {
      try { obs(this.state); } catch {}
    }
  }
}
