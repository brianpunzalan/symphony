import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { WorkspaceConfig, HooksConfig, Workspace } from '../types';
import { logger } from '../logging/logger';

export function sanitizeKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, '_');
}

function assertInsideRoot(workspacePath: string, root: string): void {
  const normalizedPath = path.resolve(workspacePath);
  const normalizedRoot = path.resolve(root);
  const rootWithSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;

  if (normalizedPath !== normalizedRoot && !normalizedPath.startsWith(rootWithSep)) {
    throw new Error(
      `Safety violation: workspace path "${normalizedPath}" is outside root "${normalizedRoot}"`,
    );
  }
}

async function runHook(script: string, cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', ['-lc', script], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    proc.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { output += d.toString(); });

    const timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      reject(new Error(`Hook timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Hook exited with code ${code}: ${output.slice(0, 500)}`));
      } else {
        resolve();
      }
    });

    proc.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export class WorkspaceManager {
  private wsConfig: WorkspaceConfig;
  private hooks: HooksConfig;

  constructor(wsConfig: WorkspaceConfig, hooks: HooksConfig) {
    this.wsConfig = wsConfig;
    this.hooks = hooks;
  }

  get root(): string {
    return this.wsConfig.root;
  }

  getWorkspacePath(identifier: string): string {
    const key = sanitizeKey(identifier);
    return path.join(this.wsConfig.root, key);
  }

  async createForIssue(identifier: string): Promise<Workspace> {
    const workspace_key = sanitizeKey(identifier);
    const workspacePath = path.join(this.wsConfig.root, workspace_key);

    assertInsideRoot(workspacePath, this.wsConfig.root);

    fs.mkdirSync(this.wsConfig.root, { recursive: true });

    const exists = fs.existsSync(workspacePath);
    const created_now = !exists;

    if (!exists) {
      fs.mkdirSync(workspacePath, { recursive: true });
      logger.info('Workspace created', { workspace_key });
    }

    if (created_now && this.hooks.after_create) {
      logger.info('Running after_create hook', { workspace_key });
      try {
        await runHook(this.hooks.after_create, workspacePath, this.hooks.timeout_ms);
      } catch (err) {
        logger.error('after_create hook failed, removing partial workspace', {
          workspace_key,
          error: String(err),
        });
        try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch {}
        throw err;
      }
    }

    return { path: workspacePath, workspace_key, created_now };
  }

  async runBeforeRun(workspacePath: string): Promise<void> {
    if (!this.hooks.before_run) return;
    logger.debug('Running before_run hook', { workspace: workspacePath });
    await runHook(this.hooks.before_run, workspacePath, this.hooks.timeout_ms);
  }

  async runAfterRun(workspacePath: string): Promise<void> {
    if (!this.hooks.after_run) return;
    try {
      logger.debug('Running after_run hook', { workspace: workspacePath });
      await runHook(this.hooks.after_run, workspacePath, this.hooks.timeout_ms);
    } catch (err) {
      logger.warn('after_run hook failed (ignored)', { workspace: workspacePath, error: String(err) });
    }
  }

  async removeWorkspace(identifier: string): Promise<void> {
    const workspace_key = sanitizeKey(identifier);
    const workspacePath = path.join(this.wsConfig.root, workspace_key);

    assertInsideRoot(workspacePath, this.wsConfig.root);

    if (!fs.existsSync(workspacePath)) return;

    if (this.hooks.before_remove) {
      try {
        await runHook(this.hooks.before_remove, workspacePath, this.hooks.timeout_ms);
      } catch (err) {
        logger.warn('before_remove hook failed (ignored)', {
          workspace_key,
          error: String(err),
        });
      }
    }

    fs.rmSync(workspacePath, { recursive: true, force: true });
    logger.info('Workspace removed', { workspace_key });
  }
}
