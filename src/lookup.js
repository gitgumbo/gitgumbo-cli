// Finding an issue or merge request by number.
//
// The v1 API has no "issue by number" endpoint and no cross-project search, so
// a lookup is per project, at the fewest calls the API allows:
//
//   1. GET /projects/{id}/board   One call holds every open issue on the board,
//                                 already bucketed into its column. Most
//                                 stand-up questions end here.
//   2. GET /projects/{id}/issues  Only when the issue is not on the board
//      ?state=all                 (closed, or outside a scoped board). Newest
//                                 activity first, so a recently touched issue
//                                 is on page one. Capped at MAX_PAGES.
//   3. GET /projects/{id}/merge-requests?state=opened&linked=true
//                                 Only when the issue has open linked MRs: the
//                                 board's compact MR has no conflicts, threads
//                                 or reviewer names.

import { CliError, EXIT } from "./api.js";

/** Pages read per project before giving up on a scan (100 items a page). */
export const MAX_PAGES = 5;

/**
 * "211", "#211" -> issue; "!305" -> merge request.
 * @param {string} arg
 * @returns {{ kind: "issue" | "mr", number: number }}
 */
export function parseRef(arg) {
  const m = /^([#!]?)(\d+)$/.exec(String(arg).trim());
  if (!m || Number(m[2]) < 1) {
    throw new CliError(`Not an issue or MR reference: "${arg}" (try 211, #211 or !305)`, EXIT.USAGE);
  }
  return { kind: m[1] === "!" ? "mr" : "issue", number: Number(m[2]) };
}

/** "group/project" when the API gives one, else the bare name. */
export function projectLabel(project) {
  return project.pathWithNamespace ?? project.nameWithNamespace ?? project.name;
}

/**
 * Narrow the firm's projects to the ones asked for. A selector matches a
 * project's id, its full path, or its name (case-insensitive); a name shared
 * by two projects selects both.
 *
 * @param {any[]} projects
 * @param {string[]} selectors  empty = every project
 */
export function selectProjects(projects, selectors) {
  if (selectors.length === 0) return projects;
  const chosen = new Set();
  for (const raw of selectors) {
    const want = raw.toLowerCase();
    const hits = projects.filter((p) =>
      p.id === raw ||
      p.pathWithNamespace?.toLowerCase() === want ||
      p.name.toLowerCase() === want);
    if (hits.length === 0) {
      const known = projects.map(projectLabel).join(", ") || "none";
      throw new CliError(`No project matches "${raw}". Your projects: ${known}`, EXIT.USAGE);
    }
    hits.forEach((p) => chosen.add(p));
  }
  return projects.filter((p) => chosen.has(p));
}

/**
 * @param {ReturnType<import("./api.js").createClient>} client
 * @param {any} project
 * @param {number} number
 * @returns {Promise<{ match: object | null, complete: boolean }>}
 */
export async function findIssue(client, project, number) {
  const base = `/projects/${encodeURIComponent(project.id)}`;
  const board = await client.get(`${base}/board`);

  let issue = null;
  let column = null;
  for (const col of board.columns) {
    const hit = col.issues.find((i) => i.number === number);
    if (hit) { issue = hit; column = col.name; break; }
  }

  let complete = true;
  if (!issue) {
    const scan = await client.find(`${base}/issues`, { state: "all" }, (i) => i.number === number, MAX_PAGES);
    issue = scan.hit;
    complete = scan.complete;
  }
  if (!issue) return { match: null, complete };

  const mergeRequests = await withMrDetails(client, base, issue.linkedMergeRequests);
  return {
    match: { project, issue, column, board: board.board?.name ?? null, mergeRequests },
    complete: true,
  };
}

/**
 * Swap each open linked MR's compact form for the full one. Merged and closed
 * MRs keep the compact form: their conflicts and threads no longer matter.
 */
async function withMrDetails(client, base, linked) {
  const wanted = new Set(linked.filter((m) => m.state === "opened").map((m) => m.number));
  if (wanted.size === 0) return linked;

  const full = new Map();
  await client.find(`${base}/merge-requests`, { state: "opened", linked: "true" }, (mr) => {
    if (wanted.has(mr.number)) full.set(mr.number, mr);
    return full.size === wanted.size; // stop paging once every one is found
  }, MAX_PAGES);
  return linked.map((m) => full.get(m.number) ?? m);
}

/**
 * @param {ReturnType<import("./api.js").createClient>} client
 * @param {any} project
 * @param {number} number
 */
export async function findMergeRequest(client, project, number) {
  const scan = await client.find(
    `/projects/${encodeURIComponent(project.id)}/merge-requests`,
    { state: "all" }, (mr) => mr.number === number, MAX_PAGES);
  return { match: scan.hit ? { project, mergeRequest: scan.hit } : null, complete: scan.complete };
}

/**
 * Look a reference up in every selected project, four projects at a time.
 *
 * @param {ReturnType<import("./api.js").createClient>} client
 * @param {{ kind: "issue" | "mr", number: number }} ref
 * @param {string[]} selectors
 */
export async function lookup(client, ref, selectors) {
  const projects = selectProjects(await client.all("/projects"), selectors);
  if (projects.length === 0) {
    throw new CliError("This firm has no projects yet.", EXIT.NOT_FOUND);
  }
  const find = ref.kind === "mr" ? findMergeRequest : findIssue;
  const results = await mapLimit(projects, 4, (p) => find(client, p, ref.number));
  return {
    ref,
    matches: results.map((r) => r.match).filter(Boolean),
    searched: projects.map(projectLabel),
    incomplete: projects.filter((_, i) => !results[i].complete).map(projectLabel),
  };
}

/** Promise.all with at most `limit` calls in flight, results in input order. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
