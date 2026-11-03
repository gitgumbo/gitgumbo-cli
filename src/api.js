// A tiny client for the GitGumbo v1 API. GET only: the API is read-only.

import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** Exit codes, documented in the README. */
export const EXIT = Object.freeze({
  OK: 0,
  NOT_FOUND: 1,
  USAGE: 2,
  AUTH: 3,
  RATE_LIMITED: 4,
  UNAVAILABLE: 5,
});

/** The API's page-size ceiling (lib/api/pagination.ts clamps `limit` to 1-100). */
export const PAGE_SIZE = 100;

export class CliError extends Error {
  /**
   * @param {string} message
   * @param {number} exitCode
   * @param {{ status?: number, code?: string, retryAfter?: number }} [details]
   */
  constructor(message, exitCode, details = {}) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.status = details.status;
    this.code = details.code;
    this.retryAfter = details.retryAfter;
  }
}

/**
 * @param {{ baseUrl: string, token: string, fetch?: typeof fetch, timeoutMs?: number }} options
 */
export function createClient({ baseUrl, token, fetch = globalThis.fetch, timeoutMs = 15_000 }) {
  const root = `${baseUrl.replace(/\/+$/, "")}/api/v1`;

  /**
   * @param {string} path  e.g. "/projects"
   * @param {Record<string, string | number | undefined>} [query]
   * @returns {Promise<any>}
   */
  async function get(path, query = {}) {
    const url = new URL(root + path);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let res;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "User-Agent": `gitgumbo-cli/${version}`,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw networkError(baseUrl, err);
    }

    const body = await res.json().catch(() => null);
    if (res.ok && body !== null) return body;
    throw httpError(res, body, baseUrl);
  }

  /**
   * Walk a paginated list endpoint ({ data, nextCursor }) until `predicate`
   * matches, the list ends, or `maxPages` pages have been read.
   *
   * @template T
   * @param {string} path
   * @param {Record<string, string | number | undefined>} query
   * @param {(item: T) => boolean} predicate
   * @param {number} maxPages
   * @returns {Promise<{ hit: T | null, complete: boolean }>}
   *   `complete` is false when the walk stopped at `maxPages` with more left.
   */
  async function find(path, query, predicate, maxPages) {
    let cursor;
    for (let page = 0; page < maxPages; page++) {
      const { data, nextCursor } = await get(path, { ...query, limit: PAGE_SIZE, cursor });
      const hit = data.find(predicate);
      if (hit) return { hit, complete: true };
      if (!nextCursor) return { hit: null, complete: true };
      cursor = nextCursor;
    }
    return { hit: null, complete: false };
  }

  /** Every item of a paginated list, up to `maxPages` pages. */
  async function all(path, query = {}, maxPages = 10) {
    const items = [];
    let cursor;
    for (let page = 0; page < maxPages; page++) {
      const { data, nextCursor } = await get(path, { ...query, limit: PAGE_SIZE, cursor });
      items.push(...data);
      if (!nextCursor) break;
      cursor = nextCursor;
    }
    return items;
  }

  return { get, find, all };
}

/** @param {string} baseUrl @param {any} err */
function networkError(baseUrl, err) {
  const reason =
    err?.name === "TimeoutError" ? "timed out"
    : err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(err);
  return new CliError(`Could not reach ${baseUrl}: ${reason}`, EXIT.UNAVAILABLE);
}

/** @param {Response} res @param {any} body @param {string} baseUrl */
function httpError(res, body, baseUrl) {
  const code = body?.error?.code;
  const detail = body?.error?.message ?? res.statusText;
  const details = { status: res.status, code };
  const tag = code ? ` (${code})` : "";

  switch (res.status) {
    case 401:
      return new CliError(
        `Token rejected${tag}: ${detail}. Create a new one at ${baseUrl}/settings/api.`,
        EXIT.AUTH, details);
    case 402:
      return new CliError(`${detail}${tag}. The GitGumbo API needs a Pro or Team plan.`, EXIT.AUTH, details);
    case 404:
      return new CliError(`Not found${tag}: ${detail}`, EXIT.NOT_FOUND, details);
    case 429:
    case 503: {
      const retryAfter = Number(res.headers.get("retry-after")) || undefined;
      const when = retryAfter ? ` Try again in ${formatDuration(retryAfter)}.` : "";
      const what = res.status === 429 ? "Rate limit exceeded" : "GitGumbo API temporarily unavailable";
      return new CliError(`${what}${tag}.${when}`, EXIT.RATE_LIMITED, { ...details, retryAfter });
    }
    default:
      return new CliError(`GitGumbo API error ${res.status}${tag}: ${detail}`, EXIT.UNAVAILABLE, details);
  }
}

/** 754 -> "12m 34s" */
export function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
