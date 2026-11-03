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
  const base = new URL(baseUrl);
  const root = `${base.origin}${base.pathname.replace(/\/+$/, "")}/api/v1`;
  const server = base.origin; // the only part of the URL a message repeats

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
        redirect: "error", // the API never redirects; following one could leave the server
      });
    } catch (err) {
      throw networkError(server, err);
    }

    const body = await res.json().catch(() => null);
    if (res.ok && body !== null) return body;
    throw httpError(res, body, server);
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

/**
 * undici rejects with TypeError("fetch failed") once the request was attempted;
 * any other error was thrown before it was sent (an invalid header, say), and
 * its message may quote the request, token included. Only the first kind's
 * cause is shown.
 *
 * @param {string} server  origin only
 * @param {any} err
 */
function networkError(server, err) {
  if (err?.name === "TimeoutError") return new CliError(`Could not reach ${server}: timed out`, EXIT.UNAVAILABLE);
  if (err?.message !== "fetch failed") {
    return new CliError(`Could not send the request to ${server}.`, EXIT.UNAVAILABLE);
  }
  if (err.cause?.message === "unexpected redirect") {
    return new CliError(`${server} answered with a redirect, which the GitGumbo API never does. Check GITGUMBO_URL.`, EXIT.UNAVAILABLE);
  }
  const reason = err.cause?.code ?? err.cause?.message ?? "connection failed";
  return new CliError(`Could not reach ${server}: ${redact(String(reason))}`, EXIT.UNAVAILABLE);
}

/** A backstop: never print a credential, whatever a cause message quotes. */
const redact = (s) => s.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/ggb_[A-Za-z0-9_-]+/g, "ggb_[redacted]");

/** @param {Response} res @param {any} body @param {string} server  origin only */
function httpError(res, body, server) {
  const code = body?.error?.code;
  const detail = body?.error?.message ?? res.statusText;
  const details = { status: res.status, code };
  const tag = code ? ` (${code})` : "";

  switch (res.status) {
    case 401:
      return new CliError(
        `Token rejected${tag}: ${detail}. Create a new one at ${server}/settings/api.`,
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
