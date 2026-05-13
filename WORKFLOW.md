---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: your-project-slug
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Cancelled
    - Canceled
    - Duplicate
    - Closed

polling:
  interval_ms: 30000

workspace:
  root: ~/symphony_workspaces

hooks:
  after_create: |
    git clone git@github.com:your-org/your-repo.git .
    npm install
  before_run: |
    git fetch origin && git pull --rebase
  after_run: |
    echo "Run completed for workspace: $(pwd)"
  timeout_ms: 120000

agent:
  max_concurrent_agents: 3
  max_turns: 20
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    in progress: 2

codex:
  command: codex app-server
  approval_policy: auto
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000

server:
  port: 8080
---

You are a coding agent working on the following issue in the {{ issue.identifier }} repository.

## Issue: {{ issue.title }}

**Identifier:** {{ issue.identifier }}
**State:** {{ issue.state }}
**URL:** {{ issue.url }}
{% if issue.priority %}**Priority:** {{ issue.priority }}{% endif %}
{% if issue.labels %}**Labels:** {{ issue.labels }}{% endif %}

## Description

{{ issue.description }}

## Your Task

1. Carefully read and understand the issue description above.
2. Explore the codebase to understand the relevant code.
3. Implement the required changes to address the issue.
4. Write or update tests as appropriate.
5. Ensure the code builds and tests pass.
6. Create a pull request with your changes.
7. Once the pull request is created, move the issue to the "Human Review" state using the `linear_graphql` tool.

## Guidelines

- Make targeted, minimal changes that directly address the issue.
- Follow the existing code style and conventions.
- Add meaningful commit messages.
- If the issue is unclear, make reasonable assumptions and document them in your PR description.
- If you encounter blockers or discover the issue is more complex than expected, explain the situation in a comment on the issue.

{% if attempt %}
## Retry Context (Attempt {{ attempt }})

This is a retry attempt. Please:
- Review the workspace for any partial work from previous attempts.
- Build on existing progress where possible.
- Address any issues that caused previous attempts to fail.
{% endif %}

Good luck!
