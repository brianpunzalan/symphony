#!/usr/bin/env node
import * as path from 'path';
import * as fs from 'fs';
import { parseWorkflowFile, validateConfig } from './config/workflow';
import { Orchestrator } from './orchestrator/orchestrator';
import { SymphonyServer } from './server/server';
import { logger } from './logging/logger';

// Trust Boundary / Approval posture:
// This implementation operates in a high-trust local environment.
// The Codex agent uses "auto" approval policy by default. Operators
// SHOULD configure stricter settings via WORKFLOW.md codex.approval_policy
// for production deployments.

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let workflowPath = path.resolve('./WORKFLOW.md');
  let port: number | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--port' || arg === '-p') && args[i + 1]) {
      port = parseInt(args[++i], 10);
      if (isNaN(port)) {
        logger.error(`Invalid port: ${args[i]}`);
        process.exit(1);
      }
    } else if ((arg === '--workflow' || arg === '-w') && args[i + 1]) {
      workflowPath = path.resolve(args[++i]);
    } else if (!arg.startsWith('-')) {
      workflowPath = path.resolve(arg);
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  if (!fs.existsSync(workflowPath)) {
    logger.error(`missing_workflow_file: "${workflowPath}" not found`);
    process.exit(1);
  }

  let workflow;
  try {
    workflow = parseWorkflowFile(workflowPath);
  } catch (err) {
    logger.error(`workflow_parse_error: ${err}`);
    process.exit(1);
  }

  const errors = validateConfig(workflow.config);
  if (errors.length > 0) {
    for (const e of errors) logger.error(`Config validation: ${e}`);
    process.exit(1);
  }

  logger.info('Symphony starting', {
    workflow_path: workflowPath,
    tracker_kind: workflow.config.tracker.kind,
    project_slug: workflow.config.tracker.project_slug,
    poll_interval_ms: workflow.config.polling.interval_ms,
    max_concurrent_agents: workflow.config.agent.max_concurrent_agents,
  });

  const orchestrator = new Orchestrator(workflow);

  // Watch WORKFLOW.md for changes and hot-reload
  let reloadDebounce: NodeJS.Timeout | null = null;
  let lastGoodWorkflow = workflow;

  const watchFile = (): void => {
    const chokidar = require('chokidar') as typeof import('chokidar');
    const watcher = chokidar.watch(workflowPath, { ignoreInitial: true, persistent: true });

    watcher.on('change', () => {
      if (reloadDebounce) clearTimeout(reloadDebounce);
      reloadDebounce = setTimeout(() => {
        try {
          const newWorkflow = parseWorkflowFile(workflowPath);
          const newErrors = validateConfig(newWorkflow.config);
          if (newErrors.length > 0) {
            logger.error(`Reload rejected — invalid config: ${newErrors.join('; ')}`);
            return;
          }
          lastGoodWorkflow = newWorkflow;
          orchestrator.updateWorkflow(newWorkflow);
          logger.info('Workflow reloaded and applied');
        } catch (err) {
          logger.error(`Reload failed — keeping last good config: ${err}`);
        }
      }, 500);
    });

    watcher.on('error', (err: unknown) => {
      logger.warn(`Workflow watch error: ${err}`);
    });
  };

  watchFile();

  // HTTP server
  const serverPort = port ?? workflow.config.server?.port;
  if (serverPort !== undefined && serverPort !== null) {
    const server = new SymphonyServer(orchestrator);
    await server.listen(serverPort);
  } else {
    logger.info('HTTP server disabled (use --port or server.port in WORKFLOW.md to enable)');
  }

  // Start orchestrator
  await orchestrator.start();

  // Graceful shutdown
  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}, shutting down...`);
    orchestrator.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function printUsage(): void {
  console.log(`
Symphony — Coding Agent Orchestration Service

Usage:
  symphony [WORKFLOW.md] [options]

Options:
  --port, -p <port>      Enable HTTP server on the given port
  --workflow, -w <path>  Path to WORKFLOW.md (default: ./WORKFLOW.md)
  --help, -h             Show this help message

Environment Variables:
  LINEAR_API_KEY         Linear API key (can also be set in WORKFLOW.md)
  LOG_LEVEL              Log level: debug | info | warn | error (default: info)

Examples:
  symphony                          # Use ./WORKFLOW.md, no HTTP server
  symphony --port 8080              # Enable dashboard at http://127.0.0.1:8080
  symphony my-project/WORKFLOW.md   # Use a custom workflow file
`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
