// Plain-text rendering. Colour is decided by the caller (TTY and NO_COLOR).

import { formatDuration } from "./api.js";
import { MAX_PAGES, projectLabel } from "./lookup.js";

const CODES = { red: 31, green: 32, yellow: 33, cyan: 36, bold: 1, dim: 2 };

/** @param {boolean} enabled */
export function painter(enabled) {
  /** @type {Record<keyof CODES, (s: string) => string>} */
  const paint = /** @type {any} */ ({});
  for (const [name, code] of Object.entries(CODES)) {
    paint[name] = enabled ? (s) => `\x1b[${code}m${s}\x1b[0m` : (s) => s;
  }
  return paint;
}

const PROVIDERS = { gitlab: "GitLab", github: "GitHub" };
const providerName = (p) => PROVIDERS[p] ?? p;

/** GitLab writes !305 for an MR; GitHub calls it PR #305. */
export function mrRef(provider, number) {
  return provider === "github" ? `PR #${number}` : `!${number}`;
}

const STATE = { opened: "open", closed: "closed", merged: "merged" };

function people(list) {
  return list.map((p) => (p.username ? `@${p.username}` : p.name ?? "?")).join(" ");
}

function pipeline(status, paint) {
  if (!status) return paint.dim("no pipeline");
  const colour =
    status === "success" ? paint.green
    : status === "failed" ? paint.red
    : ["running", "pending", "created", "waiting_for_resource", "preparing"].includes(status) ? paint.yellow
    : paint.dim;
  return `pipeline ${colour(status.replaceAll("_", " "))}`;
}

function review(mr, paint) {
  // Names come only with the full MR; the board's compact MR has the state alone.
  if (mr.reviewState === "approved") {
    const by = mr.approvedBy?.length ? ` by ${people(mr.approvedBy)}` : "";
    return paint.green(`approved${by}`);
  }
  if (mr.reviewState === "changes_requested") {
    const by = mr.changesRequestedBy?.length ? ` by ${people(mr.changesRequestedBy)}` : "";
    return paint.red(`changes requested${by}`);
  }
  return mr.reviewState ? `review ${mr.reviewState.replaceAll("_", " ")}` : "no review";
}

/** The one-line health summary of a merge request. */
export function mrStatus(mr, paint) {
  const parts = [mr.draft ? paint.dim("draft") : STATE[mr.state] ?? mr.state];
  if (mr.state !== "opened") return parts.join(" · ");

  parts.push(pipeline(mr.pipelineStatus, paint));
  if (mr.pipelineLongRunning) parts.push(paint.yellow("running 3h+"));
  if ("hasConflicts" in mr) {
    parts.push(mr.hasConflicts ? paint.red("conflicts") : "no conflicts");
    const n = mr.unresolvedThreads;
    parts.push(n > 0 ? paint.yellow(`${n} unresolved thread${n === 1 ? "" : "s"}`) : "threads resolved");
  }
  parts.push(review(mr, paint));
  return parts.join(" · ");
}

function header(project, ref, title, paint) {
  const where = paint.dim(`${providerName(project.provider)} ${projectLabel(project)}`);
  return `${paint.bold(paint.cyan(ref))}  ${paint.bold(title)}  ${where}`;
}

function mrLines(provider, mr, paint, indent) {
  return [
    `${indent}${paint.cyan(mrRef(provider, mr.number))}  ${mr.title}`,
    `${indent}  ${mrStatus(mr, paint)}`,
  ];
}

/** @param {any} match  from findIssue */
export function renderIssue(match, paint) {
  const { project, issue, column, board, mergeRequests } = match;
  const where =
    column ? paint.bold(column)
    : issue.state === "opened" ? paint.dim(board ? `not on the "${board}" board` : "not on the board")
    : paint.dim("off the board");
  const assignees = issue.assignees.length ? people(issue.assignees) : paint.dim("unassigned");

  const lines = [
    header(project, `#${issue.number}`, issue.title, paint),
    `  ${where} · ${STATE[issue.state] ?? issue.state} · ${assignees}`,
  ];
  if (issue.blocked) lines.push(`  ${paint.red(`blocked by ${issue.blockedByCount ?? "?"}`)}`);
  lines.push(`  ${paint.dim(issue.webUrl)}`);

  if (mergeRequests.length === 0) {
    lines.push(`  ${paint.dim(`no linked ${project.provider === "github" ? "PRs" : "MRs"}`)}`);
  }
  for (const mr of mergeRequests) lines.push("", ...mrLines(project.provider, mr, paint, "  "));
  return lines.join("\n");
}

/** @param {any} match  from findMergeRequest */
export function renderMergeRequest(match, paint) {
  const { project, mergeRequest: mr } = match;
  const lines = [
    header(project, mrRef(project.provider, mr.number), mr.title, paint),
    `  ${mrStatus(mr, paint)}`,
  ];
  if (mr.sourceBranch) lines.push(`  ${paint.dim(`${mr.sourceBranch} → ${mr.targetBranch ?? "?"}`)}`);
  if (mr.reviewers?.length) lines.push(`  reviewers ${people(mr.reviewers)}`);
  lines.push(`  ${paint.dim(mr.webUrl)}`);
  return lines.join("\n");
}

/** @param {Awaited<ReturnType<import("./lookup.js").lookup>>} result */
export function renderLookup(result, paint) {
  const render = result.ref.kind === "mr" ? renderMergeRequest : renderIssue;
  return result.matches.map((m) => render(m, paint)).join("\n\n");
}

/** Why nothing came back, with what was searched and what was not. */
export function renderNotFound(result) {
  const { ref, searched, incomplete } = result;
  const what = ref.kind === "mr" ? `MR !${ref.number}` : `Issue #${ref.number}`;
  let msg = `${what} not found in ${searched.join(", ")}.`;
  if (incomplete.length) {
    const kind = ref.kind === "mr" ? "merge requests" : "issues";
    msg += ` Only the ${MAX_PAGES * 100} most recently updated ${kind} were searched in ${incomplete.join(", ")}.`;
  }
  if (ref.kind === "issue") msg += ` If it is a merge request or pull request, try '!${ref.number}'.`;
  return msg;
}

export function renderProjects(projects, paint) {
  if (projects.length === 0) return "No projects yet.";
  return projects
    .map((p) => `${projectLabel(p)}  ${paint.dim(`${providerName(p.provider)} · id ${p.id}`)}`)
    .join("\n");
}

export function renderMe(me, paint) {
  const { firm, token, rateLimit } = me;
  const resetIn = Math.max(0, rateLimit.reset - Math.floor(Date.now() / 1000));
  return [
    `${paint.bold(firm.name)}  ${paint.dim(`${firm.plan} plan`)}`,
    `token "${token.name}" (${token.scopes.join(", ")}), ${token.expiresAt ? `expires ${token.expiresAt.slice(0, 10)}` : "no expiry"}`,
    `rate limit ${rateLimit.remaining}/${rateLimit.limit} left, resets in ${formatDuration(resetIn)}`,
  ].join("\n");
}
