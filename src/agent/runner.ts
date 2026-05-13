import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';
import { CodexConfig, Issue, LiveSession } from '../types';
import { logger } from '../logging/logger';

export interface CodexEvent {
  event: string;
  timestamp: string;
  codex_app_server_pid: string | null;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  data?: unknown;
  message?: string;
}

export interface AgentCallbacks {
  onEvent: (event: CodexEvent) => void;
  onSessionUpdate: (update: Partial<LiveSession>) => void;
}

export interface TurnResult {
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out';
  error?: string;
}

export type LinearGraphqlFn = (
  query: string,
  variables?: Record<string, unknown>,
) => Promise<unknown>;

export class AgentRunner {
  private config: CodexConfig;
  private proc: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private _threadId: string | null = null;
  private _pid: string | null = null;

  constructor(config: CodexConfig) {
    this.config = config;
  }

  get pid(): string | null { return this._pid; }
  get threadId(): string | null { return this._threadId; }

  async start(workspacePath: string): Promise<{ thread_id: string; pid: string }> {
    return new Promise((resolve, reject) => {
      const startTimer = setTimeout(() => {
        this.cleanup();
        reject(Object.assign(new Error('Codex startup timed out'), { code: 'response_timeout' }));
      }, this.config.read_timeout_ms);

      try {
        this.proc = spawn('bash', ['-lc', this.config.command], {
          cwd: workspacePath,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env },
        });
      } catch (err) {
        clearTimeout(startTimer);
        reject(Object.assign(new Error(`codex_not_found: ${err}`), { code: 'codex_not_found' }));
        return;
      }

      if (!this.proc.pid) {
        clearTimeout(startTimer);
        reject(Object.assign(new Error('Failed to get PID'), { code: 'codex_not_found' }));
        return;
      }

      this._pid = String(this.proc.pid);
      this.rl = readline.createInterface({
        input: this.proc.stdout!,
        crlfDelay: Infinity,
      });

      const onLine = (line: string) => {
        if (!line.trim()) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }

        const event = String(msg['event'] ?? msg['type'] ?? '');
        if (event === 'session_started' || event === 'ready') {
          clearTimeout(startTimer);
          this.rl!.off('line', onLine);
          this._threadId = String(msg['thread_id'] ?? `thread-${Date.now()}`);
          resolve({ thread_id: this._threadId, pid: this._pid! });
        } else if (event === 'startup_failed') {
          clearTimeout(startTimer);
          this.rl!.off('line', onLine);
          this.cleanup();
          reject(Object.assign(new Error(String(msg['error'] ?? 'Startup failed')), { code: 'startup_failed' }));
        }
      };

      this.rl.on('line', onLine);

      this.proc.on('error', err => {
        clearTimeout(startTimer);
        reject(Object.assign(err, { code: 'codex_not_found' }));
      });

      this.proc.on('close', code => {
        if (code !== 0) {
          clearTimeout(startTimer);
          reject(Object.assign(new Error(`Codex exited with code ${code}`), { code: 'port_exit' }));
        }
      });

      // Send init message
      this.send({
        type: 'init',
        approval_policy: this.config.approval_policy,
        thread_sandbox: this.config.thread_sandbox,
        turn_sandbox_policy: this.config.turn_sandbox_policy,
      });

      // If no session_started arrives, treat first JSON line as implicit start
      // after a brief moment (permissive for various codex versions)
      setTimeout(() => {
        if (!this._threadId) {
          clearTimeout(startTimer);
          this.rl!.off('line', onLine);
          this._threadId = `thread-${Date.now()}`;
          resolve({ thread_id: this._threadId, pid: this._pid! });
        }
      }, Math.min(this.config.read_timeout_ms, 2000));
    });
  }

  async runTurn(
    prompt: string,
    issue: Issue,
    attempt: number | null,
    callbacks: AgentCallbacks,
    abortSignal: AbortSignal,
    linearGraphql?: LinearGraphqlFn,
  ): Promise<TurnResult> {
    if (!this.proc || !this.rl || !this._threadId) {
      return { status: 'failed', error: 'Agent not started' };
    }

    return new Promise(resolve => {
      let settled = false;
      const settle = (result: TurnResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(turnTimer);
        abortSignal.removeEventListener('abort', onAbort);
        this.rl!.off('line', onLine);
        resolve(result);
      };

      const turnTimer = setTimeout(() => {
        settle({ status: 'timed_out', error: `Turn timed out after ${this.config.turn_timeout_ms}ms` });
      }, this.config.turn_timeout_ms);

      const onAbort = () => {
        settle({ status: 'cancelled', error: 'Cancelled by orchestrator' });
      };
      abortSignal.addEventListener('abort', onAbort, { once: true });

      const onLine = async (line: string) => {
        if (!line.trim()) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          callbacks.onEvent({
            event: 'malformed',
            timestamp: new Date().toISOString(),
            codex_app_server_pid: this._pid,
            message: line.slice(0, 200),
          });
          return;
        }

        const event = String(msg['event'] ?? msg['type'] ?? 'other_message');
        const timestamp = String(msg['timestamp'] ?? new Date().toISOString());

        const evt: CodexEvent = {
          event,
          timestamp,
          codex_app_server_pid: this._pid,
          usage: msg['usage'] as CodexEvent['usage'],
          data: msg['data'],
          message: msg['message'] ? String(msg['message']) : msg['content'] ? String(msg['content']) : undefined,
        };

        // linear_graphql tool call
        if ((event === 'tool_call' || event === 'function_call') && linearGraphql) {
          const tool = String(msg['tool'] ?? msg['function'] ?? '');
          if (tool === 'linear_graphql') {
            const input = (msg['input'] ?? msg['arguments'] ?? {}) as Record<string, unknown>;
            const gqlQuery = String(input['query'] ?? '');
            const variables = (input['variables'] ?? undefined) as Record<string, unknown> | undefined;
            try {
              const result = await linearGraphql(gqlQuery, variables);
              this.send({ type: 'tool_result', tool_call_id: msg['tool_call_id'], success: true, result });
            } catch (err) {
              this.send({ type: 'tool_result', tool_call_id: msg['tool_call_id'], success: false, error: String(err) });
            }
            return;
          } else {
            // Unsupported tool
            this.send({
              type: 'tool_result',
              tool_call_id: msg['tool_call_id'],
              success: false,
              error: `unsupported_tool_call: ${tool}`,
            });
            callbacks.onEvent({ ...evt, event: 'unsupported_tool_call' });
            return;
          }
        }

        // Approval requests - auto-approve per policy
        if (event === 'approval_required' || event === 'confirmation_required') {
          if (this.config.approval_policy === 'auto') {
            this.send({ type: 'approval_response', approval_id: msg['approval_id'], approved: true });
            callbacks.onEvent({ ...evt, event: 'approval_auto_approved' });
          }
          return;
        }

        // User input required - fail the turn, don't stall indefinitely
        if (event === 'turn_input_required' || event === 'input_required') {
          callbacks.onEvent(evt);
          settle({ status: 'failed', error: 'turn_input_required: agent requested user input' });
          return;
        }

        callbacks.onEvent(evt);

        // Update session metadata
        const sessionUpdate: Partial<LiveSession> = {
          last_codex_event: event,
          last_codex_timestamp: timestamp,
        };
        if (evt.message) {
          sessionUpdate.last_codex_message = evt.message.slice(0, 500);
        }

        // Token accounting - prefer absolute thread totals
        const usage = (msg['usage'] ?? msg['token_usage'] ?? msg['tokenUsage']) as Record<string, number> | undefined;
        if (usage) {
          if (usage['input_tokens'] !== undefined) sessionUpdate.codex_input_tokens = usage['input_tokens'];
          if (usage['output_tokens'] !== undefined) sessionUpdate.codex_output_tokens = usage['output_tokens'];
          if (usage['total_tokens'] !== undefined) sessionUpdate.codex_total_tokens = usage['total_tokens'];
        }

        callbacks.onSessionUpdate(sessionUpdate);

        // Turn completion signals
        if (event === 'turn_completed' || event === 'completion') {
          settle({ status: 'completed' });
        } else if (event === 'turn_failed' || event === 'turn_ended_with_error' || event === 'error') {
          settle({ status: 'failed', error: String(msg['error'] ?? msg['message'] ?? 'Turn failed') });
        } else if (event === 'turn_cancelled' || event === 'cancelled') {
          settle({ status: 'cancelled' });
        }
      };

      this.rl!.on('line', onLine);

      this.proc!.once('close', () => {
        settle({ status: 'failed', error: 'port_exit: codex process exited during turn' });
      });

      // Send turn request
      this.send({
        type: 'turn',
        thread_id: this._threadId,
        prompt,
        issue_identifier: issue.identifier,
        issue_title: issue.title,
        attempt: attempt ?? 0,
        tools: ['linear_graphql'],
      });
    });
  }

  cleanup(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.proc) {
      try { this.proc.kill('SIGTERM'); } catch {}
      this.proc = null;
    }
  }

  private send(msg: Record<string, unknown>): void {
    try {
      if (this.proc?.stdin?.writable) {
        this.proc.stdin.write(JSON.stringify(msg) + '\n');
      }
    } catch (err) {
      logger.warn('Failed to send message to codex process', { error: String(err) });
    }
  }
}
