import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import {
  WorkflowConfig,
  WorkflowDefinition,
  TrackerConfig,
  PollingConfig,
  WorkspaceConfig,
  HooksConfig,
  AgentConfig,
  CodexConfig,
} from '../types';

const DEFAULTS = {
  tracker: {
    kind: '',
    endpoint: 'https://api.linear.app/graphql',
    api_key: '',
    project_slug: '',
    active_states: ['Todo', 'In Progress'],
    terminal_states: ['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done'],
  },
  polling: { interval_ms: 30000 },
  workspace: { root: path.join(os.tmpdir(), 'symphony_workspaces') },
  hooks: { after_create: null, before_run: null, after_run: null, before_remove: null, timeout_ms: 60000 },
  agent: { max_concurrent_agents: 10, max_turns: 20, max_retry_backoff_ms: 300000, max_concurrent_agents_by_state: {} },
  codex: {
    command: 'codex app-server',
    approval_policy: 'auto',
    thread_sandbox: 'none',
    turn_sandbox_policy: 'none',
    turn_timeout_ms: 3600000,
    read_timeout_ms: 5000,
    stall_timeout_ms: 300000,
  },
} as const;

function resolveVar(value: unknown): string {
  if (typeof value === 'string' && value.startsWith('$')) {
    const varName = value.slice(1);
    return process.env[varName] ?? '';
  }
  return typeof value === 'string' ? value : '';
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, name) => process.env[name] ?? '');
}

function expandPath(p: string, workflowDir: string): string {
  if (p.startsWith('~/') || p === '~') {
    p = os.homedir() + p.slice(1);
  }
  if (!path.isAbsolute(p)) {
    p = path.resolve(workflowDir, p);
  }
  return p;
}

function getRaw(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  return (obj[key] as Record<string, unknown>) ?? {};
}

function buildConfig(raw: Record<string, unknown>, workflowDir: string): WorkflowConfig {
  const rt = getRaw(raw, 'tracker');
  const rp = getRaw(raw, 'polling');
  const rw = getRaw(raw, 'workspace');
  const rh = getRaw(raw, 'hooks');
  const ra = getRaw(raw, 'agent');
  const rc = getRaw(raw, 'codex');
  const rs = getRaw(raw, 'server');

  let workspaceRoot = String(rw['root'] ?? DEFAULTS.workspace.root);
  workspaceRoot = resolveEnvVars(workspaceRoot);
  workspaceRoot = expandPath(workspaceRoot, workflowDir);

  const tracker: TrackerConfig = {
    kind: String(rt['kind'] ?? DEFAULTS.tracker.kind),
    endpoint: String(rt['endpoint'] ?? DEFAULTS.tracker.endpoint),
    api_key: resolveVar(rt['api_key'] ?? DEFAULTS.tracker.api_key) || resolveVar('$LINEAR_API_KEY'),
    project_slug: String(rt['project_slug'] ?? DEFAULTS.tracker.project_slug),
    active_states: Array.isArray(rt['active_states'])
      ? (rt['active_states'] as unknown[]).map(String)
      : [...DEFAULTS.tracker.active_states],
    terminal_states: Array.isArray(rt['terminal_states'])
      ? (rt['terminal_states'] as unknown[]).map(String)
      : [...DEFAULTS.tracker.terminal_states],
  };

  // Fallback: if api_key still looks like $VAR, try env directly
  if (tracker.api_key === '' && process.env.LINEAR_API_KEY) {
    tracker.api_key = process.env.LINEAR_API_KEY;
  }

  const polling: PollingConfig = {
    interval_ms: Number(rp['interval_ms'] ?? DEFAULTS.polling.interval_ms),
  };

  const workspace: WorkspaceConfig = { root: workspaceRoot };

  const hooks: HooksConfig = {
    after_create: rh['after_create'] ? String(rh['after_create']) : null,
    before_run: rh['before_run'] ? String(rh['before_run']) : null,
    after_run: rh['after_run'] ? String(rh['after_run']) : null,
    before_remove: rh['before_remove'] ? String(rh['before_remove']) : null,
    timeout_ms: Number(rh['timeout_ms'] ?? DEFAULTS.hooks.timeout_ms),
  };

  const agent: AgentConfig = {
    max_concurrent_agents: Number(ra['max_concurrent_agents'] ?? DEFAULTS.agent.max_concurrent_agents),
    max_turns: Number(ra['max_turns'] ?? DEFAULTS.agent.max_turns),
    max_retry_backoff_ms: Number(ra['max_retry_backoff_ms'] ?? DEFAULTS.agent.max_retry_backoff_ms),
    max_concurrent_agents_by_state:
      (ra['max_concurrent_agents_by_state'] as Record<string, number>) ?? {},
  };

  const codex: CodexConfig = {
    command: String(rc['command'] ?? DEFAULTS.codex.command),
    approval_policy: String(rc['approval_policy'] ?? DEFAULTS.codex.approval_policy),
    thread_sandbox: String(rc['thread_sandbox'] ?? DEFAULTS.codex.thread_sandbox),
    turn_sandbox_policy: String(rc['turn_sandbox_policy'] ?? DEFAULTS.codex.turn_sandbox_policy),
    turn_timeout_ms: Number(rc['turn_timeout_ms'] ?? DEFAULTS.codex.turn_timeout_ms),
    read_timeout_ms: Number(rc['read_timeout_ms'] ?? DEFAULTS.codex.read_timeout_ms),
    stall_timeout_ms: Number(rc['stall_timeout_ms'] ?? DEFAULTS.codex.stall_timeout_ms),
  };

  const config: WorkflowConfig = { tracker, polling, workspace, hooks, agent, codex };

  if (rs['port'] !== undefined) {
    config.server = { port: Number(rs['port']) };
  }

  return config;
}

export function parseWorkflowFile(filePath: string): WorkflowDefinition {
  const content = fs.readFileSync(filePath, 'utf-8');
  const workflowDir = path.dirname(path.resolve(filePath));

  let rawConfig: Record<string, unknown> = {};
  let promptTemplate = content.trim();

  const fmMatch = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/);
  if (fmMatch) {
    const yamlContent = fmMatch[1];
    const body = fmMatch[2];
    const parsed = yaml.load(yamlContent);
    if (parsed === null || parsed === undefined) {
      rawConfig = {};
    } else if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('workflow_front_matter_not_a_map: front matter must be a YAML map');
    } else {
      rawConfig = parsed as Record<string, unknown>;
    }
    promptTemplate = body.trim();
  }

  const config = buildConfig(rawConfig, workflowDir);
  return { config, prompt_template: promptTemplate };
}

export function validateConfig(config: WorkflowConfig): string[] {
  const errors: string[] = [];
  if (!config.tracker.kind) errors.push('tracker.kind is required');
  else if (config.tracker.kind !== 'linear') errors.push(`tracker.kind "${config.tracker.kind}" is not supported`);
  if (!config.tracker.api_key) errors.push('tracker.api_key is required (set LINEAR_API_KEY env var or tracker.api_key in WORKFLOW.md)');
  if (!config.tracker.project_slug) errors.push('tracker.project_slug is required');
  if (!config.codex.command) errors.push('codex.command is required');
  return errors;
}
