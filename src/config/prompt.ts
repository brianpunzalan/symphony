import { Issue } from '../types';

function buildContext(issue: Issue, attempt: number | null): Record<string, string> {
  const ctx: Record<string, string> = {
    'issue.id': issue.id,
    'issue.identifier': issue.identifier,
    'issue.title': issue.title,
    'issue.description': issue.description ?? '',
    'issue.state': issue.state,
    'issue.priority': issue.priority !== null && issue.priority !== undefined ? String(issue.priority) : '',
    'issue.url': issue.url ?? '',
    'issue.branch_name': issue.branch_name ?? '',
    'issue.labels': issue.labels.join(', '),
  };
  if (attempt !== null && attempt !== undefined) {
    ctx['attempt'] = String(attempt);
  }
  return ctx;
}

export function renderPrompt(template: string, issue: Issue, attempt: number | null): string {
  const ctx = buildContext(issue, attempt);

  return template.replace(/\{\{-?\s*([\w.]+)\s*-?\}\}/g, (match, varName: string) => {
    if (!(varName in ctx)) {
      throw new Error(`template_render_error: unknown variable "${varName}" in prompt template`);
    }
    return ctx[varName];
  });
}
