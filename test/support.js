// Test support: response builders, a schema check, and a stubbed fetch.
//
// fixtures/openapi-responses.json is copied verbatim from GitGumbo's published
// OpenAPI document (the 200 schemas of the five endpoints this tool calls).
// Every body the stub serves is checked against it, strictly: a missing
// required field, a wrong type, or a field the API does not have fails the
// test. So these builders cannot drift from the real API unnoticed.

import { readFileSync } from "node:fs";

const spec = JSON.parse(readFileSync(new URL("./fixtures/openapi-responses.json", import.meta.url), "utf8"));

/** Validate `value` against a (small) JSON Schema; returns a list of problems. */
export function validate(schema, value, at = "$") {
  const types = [].concat(schema.type ?? []);
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
  const ok = types.length === 0 || types.includes(actual) || (actual === "integer" && types.includes("number"));
  if (!ok) return [`${at}: expected ${types.join("|")}, got ${actual}`];
  if (schema.enum && !schema.enum.includes(value)) return [`${at}: ${JSON.stringify(value)} not in ${schema.enum}`];

  const problems = [];
  if (actual === "array" && schema.items) {
    value.forEach((v, i) => problems.push(...validate(schema.items, v, `${at}[${i}]`)));
  }
  if (actual === "object" && schema.properties) {
    for (const key of schema.required ?? []) if (!(key in value)) problems.push(`${at}.${key}: missing`);
    for (const [key, v] of Object.entries(value)) {
      const sub = schema.properties[key];
      if (!sub) problems.push(`${at}.${key}: not in the API schema`);
      else problems.push(...validate(sub, v, `${at}.${key}`));
    }
  }
  return problems;
}

/** "/api/v1/projects/p1/board" -> the spec path "/projects/{id}/board". */
export function specPathOf(pathname) {
  return pathname.replace(/^\/api\/v1/, "").replace(/^\/projects\/[^/]+/, (m) => (m === "/projects" ? m : "/projects/{id}"));
}

export function assertMatchesSpec(pathname, body) {
  const schema = spec.responses[specPathOf(pathname)];
  if (!schema) throw new Error(`No schema for ${pathname}`);
  const problems = validate(schema, body);
  if (problems.length) throw new Error(`Fixture for ${pathname} does not match the API:\n  ${problems.join("\n  ")}`);
}

// --- Builders. Field lists follow lib/api/schemas.ts exactly. ---------------

export const person = (username, name = username) => ({ username, name, avatarUrl: null });

export function project(o = {}) {
  return {
    id: "proj_gl", remoteProjectId: "4211", provider: "gitlab", name: "web",
    nameWithNamespace: "Acme / web", pathWithNamespace: "acme/web",
    webUrl: "https://gitlab.com/acme/web", boardMode: "auto", syncEnabled: true,
    lastSyncAt: "2026-11-03T08:00:00.000Z", ...o,
  };
}

export function mrCompact(o = {}) {
  return {
    number: 305, title: "Fix redirect loop on expired session", state: "opened", draft: false,
    webUrl: "https://gitlab.com/acme/web/-/merge_requests/305",
    pipelineStatus: "failed", reviewState: "changes_requested",
    pipelineStartedAt: "2026-11-03T07:40:00.000Z", pipelineLongRunning: false, ...o,
  };
}

export function mr(o = {}) {
  return {
    ...mrCompact(),
    sourceBranch: "fix/redirect-loop", targetBranch: "main",
    authorName: "Alice", authorUsername: "alice", authorAvatarUrl: null,
    hasConflicts: true, mergeStatus: "cannot_be_merged",
    reviewers: [person("bob")], approvedBy: [], changesRequestedBy: [person("bob")],
    unresolvedThreads: 2, labels: [],
    remoteCreatedAt: "2026-11-01T10:00:00.000Z", remoteUpdatedAt: "2026-11-03T07:41:00.000Z",
    lastCommitAt: "2026-11-03T07:39:00.000Z", ...o,
  };
}

export function issue(o = {}) {
  return {
    number: 211, title: "Login redirect loops after session expiry", state: "opened",
    webUrl: "https://gitlab.com/acme/web/-/issues/211", labels: ["bug"],
    assignees: [person("alice")], authorName: "Carol", authorUsername: "carol",
    remoteCreatedAt: "2026-10-28T09:00:00.000Z", remoteUpdatedAt: "2026-11-03T07:41:00.000Z",
    dueDate: null, milestoneTitle: null, milestoneDueDate: null,
    statusName: null, statusCategory: null, blocked: false, blockedByCount: 0,
    confidential: false, issueType: "issue", blockedBy: [], blockingCount: 0, blocking: [],
    relatesTo: [], relatesToHasMore: false, linkedMergeRequests: [mrCompact()], ...o,
  };
}

export function column(name, issues = [], o = {}) {
  return { name, type: "label", labels: [name], match: null, color: null, wipLimit: null, issues, ...o };
}

export function board(columns, o = {}) {
  return { board: { remoteBoardId: "7", name: "Development", assigneeUsername: null }, columns, truncated: false, ...o };
}

export const page = (data, nextCursor = null) => ({ data, nextCursor });

export function me(o = {}) {
  return {
    firm: { id: "firm_1", name: "Acme", plan: "pro" },
    token: { name: "laptop", scopes: ["read"], expiresAt: "2027-01-31T00:00:00.000Z" },
    rateLimit: { limit: 1000, remaining: 994, reset: Math.floor(Date.now() / 1000) + 1800 },
    ...o,
  };
}

/**
 * A fetch stub. `routes` maps "/projects/proj_gl/board" (path after /api/v1,
 * optionally with "?query") to a body, a `{ status, body, headers }` reply, or a
 * function of the URL returning either. 200 bodies are checked against the spec.
 */
export function stubFetch(routes) {
  const calls = [];
  const fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const key = [`${path}?${url.searchParams}`, path].find((k) => k in routes);
    if (!key) return reply(404, { error: { code: "not_found", message: `stub: no route for ${path}?${url.searchParams}` } });

    let r = routes[key];
    if (typeof r === "function") r = r(url);
    if (r instanceof Error) throw r;
    const isReply = r && typeof r === "object" && "status" in r && "body" in r;
    const { status = 200, body, headers = {} } = isReply ? r : { body: r };
    if (status === 200) assertMatchesSpec(url.pathname, body);
    return reply(status, body, headers);
  };
  return { fetch, calls };
}

function reply(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** Run the CLI in-process; returns { code, out, err, calls }. */
export async function run(args, { routes = {}, env = {}, tty = false } = {}) {
  const { main } = await import("../src/cli.js");
  const { fetch, calls } = stubFetch(routes);
  let out = "", err = "";
  const code = await main({
    argv: args,
    env: { GITGUMBO_TOKEN: "ggb_test", GITGUMBO_URL: "https://gg.test", ...env },
    fetch,
    stdout: { write: (s) => { out += s; }, isTTY: tty },
    stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err, calls };
}
