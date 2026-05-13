import axios, { AxiosInstance } from 'axios';
import { Issue, TrackerConfig } from '../types';

const NETWORK_TIMEOUT_MS = 30000;
const DEFAULT_PAGE_SIZE = 50;

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  state { name }
  branchName
  url
  labels { nodes { name } }
  relations(filter: { type: { eq: "blocks" } }) {
    nodes {
      relatedIssue {
        id
        identifier
        state { name }
      }
    }
  }
  createdAt
  updatedAt
`;

export class LinearTrackerClient {
  private http: AxiosInstance;
  private config: TrackerConfig;

  constructor(config: TrackerConfig) {
    this.config = config;
    this.http = axios.create({
      baseURL: config.endpoint,
      timeout: NETWORK_TIMEOUT_MS,
      headers: {
        Authorization: config.api_key,
        'Content-Type': 'application/json',
      },
    });
  }

  private async gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    let response;
    try {
      response = await this.http.post('', { query, variables });
    } catch (err) {
      throw Object.assign(new Error(`linear_api_request: ${err}`), { code: 'linear_api_request' });
    }

    if (response.status !== 200) {
      throw Object.assign(new Error(`linear_api_status: HTTP ${response.status}`), {
        code: 'linear_api_status',
        status: response.status,
      });
    }

    const payload = response.data as { data?: T; errors?: unknown[] };

    if (payload.errors && payload.errors.length > 0) {
      throw Object.assign(
        new Error(`linear_graphql_errors: ${JSON.stringify(payload.errors)}`),
        { code: 'linear_graphql_errors', errors: payload.errors },
      );
    }

    if (!payload.data) {
      throw Object.assign(new Error('linear_unknown_payload: no data field'), {
        code: 'linear_unknown_payload',
      });
    }

    return payload.data as T;
  }

  private normalizeIssue(raw: Record<string, unknown>): Issue {
    const stateObj = raw['state'] as Record<string, unknown> | null;
    const state = stateObj ? String(stateObj['name'] ?? '') : '';

    const labelNodes =
      ((raw['labels'] as Record<string, unknown>)?.['nodes'] as Array<Record<string, unknown>>) ?? [];
    const labels = labelNodes.map(l => String(l['name'] ?? '').toLowerCase());

    const relationNodes =
      ((raw['relations'] as Record<string, unknown>)?.['nodes'] as Array<Record<string, unknown>>) ?? [];
    const blocked_by = relationNodes
      .map(rel => {
        const related = rel['relatedIssue'] as Record<string, unknown> | null;
        if (!related) return null;
        const relState = related['state'] as Record<string, unknown> | null;
        return {
          id: String(related['id'] ?? ''),
          identifier: String(related['identifier'] ?? ''),
          state: relState ? String(relState['name'] ?? '') : undefined,
        };
      })
      .filter((b): b is NonNullable<typeof b> => b !== null);

    const rawPriority = raw['priority'];
    let priority: number | null = null;
    if (rawPriority !== null && rawPriority !== undefined) {
      const n = Number(rawPriority);
      if (!isNaN(n)) priority = n;
    }

    return {
      id: String(raw['id'] ?? ''),
      identifier: String(raw['identifier'] ?? ''),
      title: String(raw['title'] ?? ''),
      description: raw['description'] ? String(raw['description']) : null,
      priority,
      state,
      branch_name: raw['branchName'] ? String(raw['branchName']) : null,
      url: raw['url'] ? String(raw['url']) : null,
      labels,
      blocked_by,
      created_at: raw['createdAt'] ? String(raw['createdAt']) : null,
      updated_at: raw['updatedAt'] ? String(raw['updatedAt']) : null,
    };
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    const query = `
      query GetCandidateIssues($projectSlug: String!, $states: [String!]!, $first: Int!, $after: String) {
        issues(
          filter: {
            project: { slugId: { eq: $projectSlug } }
            state: { name: { in: $states } }
          }
          first: $first
          after: $after
        ) {
          nodes { ${ISSUE_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;

    type CandidatePage = {
      issues: {
        nodes: Record<string, unknown>[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    };

    const issues: Issue[] = [];
    let cursor: string | null = null;

    while (true) {
      const page: CandidatePage = await this.gql<CandidatePage>(query, {
        projectSlug: this.config.project_slug,
        states: this.config.active_states,
        first: DEFAULT_PAGE_SIZE,
        after: cursor,
      });

      for (const node of page.issues.nodes) {
        issues.push(this.normalizeIssue(node));
      }

      if (!page.issues.pageInfo.hasNextPage) break;

      if (!page.issues.pageInfo.endCursor) {
        throw Object.assign(new Error('linear_missing_end_cursor'), { code: 'linear_missing_end_cursor' });
      }

      cursor = page.issues.pageInfo.endCursor;
    }

    return issues;
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    if (stateNames.length === 0) return [];

    const query = `
      query GetIssuesByStates($projectSlug: String!, $states: [String!]!, $first: Int!) {
        issues(
          filter: {
            project: { slugId: { eq: $projectSlug } }
            state: { name: { in: $states } }
          }
          first: $first
        ) {
          nodes { ${ISSUE_FIELDS} }
        }
      }
    `;

    const data = await this.gql<{ issues: { nodes: Record<string, unknown>[] } }>(query, {
      projectSlug: this.config.project_slug,
      states: stateNames,
      first: 250,
    });

    return data.issues.nodes.map(n => this.normalizeIssue(n));
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    if (issueIds.length === 0) return [];

    const query = `
      query GetIssueStates($ids: [ID!]!) {
        issues(filter: { id: { in: $ids } }, first: 250) {
          nodes { ${ISSUE_FIELDS} }
        }
      }
    `;

    const data = await this.gql<{ issues: { nodes: Record<string, unknown>[] } }>(query, {
      ids: issueIds,
    });

    return data.issues.nodes.map(n => this.normalizeIssue(n));
  }

  async executeGraphQL(query: string, variables?: Record<string, unknown>): Promise<unknown> {
    return this.gql(query, variables);
  }
}
