// Argument parsing, configuration and output. Everything the process touches
// (argv, env, fetch, stdout, stderr) is passed in, so tests drive it directly.

import { parseArgs } from "node:util";
import { createClient, CliError, EXIT } from "./api.js";
import { lookup, parseRef } from "./lookup.js";
import { clean, cleanLine, painter, renderLookup, renderMe, renderNotFound, renderProjects, toJson } from "./format.js";

export const DEFAULT_URL = "https://gitgumbo.com";

const HELP = `Usage: gitgumbo <ref> [options]
       gitgumbo projects | me

Where is an issue on the board, and how are its merge requests doing?

  gitgumbo 211           issue #211: column, state, assignees, linked MRs/PRs
  gitgumbo '#211'        the same (quote it: # starts a shell comment)
  gitgumbo '!305'        merge request !305 (GitLab) or PR #305 (GitHub)
  gitgumbo mr 305        the same, without the quoting
  gitgumbo projects      list your projects, to pick a default
  gitgumbo me            your firm, token and remaining rate limit

Options:
  -p, --project <name>   search only this project (id, group/path or name);
                         repeatable. Default: $GITGUMBO_PROJECT, else all.
      --json             machine-readable output
      --no-color         no colour (also when NO_COLOR is set or not a TTY)
  -h, --help             this help
  -v, --version          print the version

Environment:
  GITGUMBO_TOKEN         API token (ggb_...), from <url>/settings/api
  GITGUMBO_URL           default ${DEFAULT_URL}; must be https
  GITGUMBO_PROJECT       default project(s), comma-separated

Exit codes: 0 found, 1 not found, 2 usage or config, 3 token or plan
rejected, 4 rate limited, 5 network or server error.`;

/**
 * @param {{
 *   argv: string[], env: Record<string, string | undefined>,
 *   fetch?: typeof fetch, stdout: { write(s: string): unknown, isTTY?: boolean },
 *   stderr: { write(s: string): unknown }, version?: string,
 * }} io
 * @returns {Promise<number>} the exit code
 */
export async function main({ argv, env, fetch, stdout, stderr, version = "0.0.0" }) {
  // Known before parsing, so a usage error under --json is JSON too.
  const end = argv.indexOf("--");
  let json = (end === -1 ? argv : argv.slice(0, end)).some((a) => a === "--json" || a.startsWith("--json="));
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        project: { type: "string", short: "p", multiple: true },
        json: { type: "boolean" },
        "no-color": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
    json = Boolean(values.json);

    if (values.help) return print(stdout, HELP);
    if (values.version) return print(stdout, version);

    const command = commandOf(positionals);
    const client = createClient({ ...config(env), fetch });
    const color = !values["no-color"] && Boolean(stdout.isTTY) && !env.NO_COLOR;
    const paint = painter(color);

    if (command.name === "projects") {
      const projects = await client.all("/projects");
      return print(stdout, json ? toJson(projects) : renderProjects(projects, paint));
    }
    if (command.name === "me") {
      const me = await client.get("/me");
      return print(stdout, json ? toJson(me) : renderMe(me, paint));
    }

    const selectors = values.project ?? splitList(env.GITGUMBO_PROJECT);
    const { failures, ...result } = await lookup(client, command.ref, selectors);
    for (const { project, message } of failures.failed) {
      stderr.write(`gitgumbo: warning: could not search ${cleanLine(project)}: ${cleanLine(message)}\n`);
    }
    if (failures.skipped.length) {
      stderr.write(`gitgumbo: warning: not searched after that error: ${cleanLine(failures.skipped.join(", "))}\n`);
    }
    if (json) {
      print(stdout, toJson(result));
    } else if (result.matches.length) {
      print(stdout, renderLookup(result, paint));
    } else {
      stderr.write(renderNotFound(result) + "\n");
    }
    return result.matches.length ? EXIT.OK : EXIT.NOT_FOUND;
  } catch (err) {
    const known = err instanceof CliError;
    const parseError = !known && Boolean(err?.code?.startsWith?.("ERR_PARSE_ARGS"));
    const code = known ? err.exitCode : parseError ? EXIT.USAGE : EXIT.UNAVAILABLE;
    const message = known || parseError ? err.message : `Unexpected error: ${err?.stack ?? err}`;
    if (json) {
      // error.code is the API's error code; Node's own parse-error code is not one.
      const apiCode = parseError ? undefined : err.code;
      print(stdout, toJson({ error: { message, exitCode: code, status: err.status, code: apiCode, retryAfter: err.retryAfter } }));
    }
    stderr.write(`gitgumbo: ${clean(message)}\n`);
    return code;
  }
}

/** @returns {{ name: "projects" | "me" } | { name: "lookup", ref: ReturnType<typeof parseRef> }} */
function commandOf(positionals) {
  const [first, second, ...rest] = positionals;
  if (!first) throw new CliError("Which issue? Try: gitgumbo 211 (or gitgumbo --help)", EXIT.USAGE);
  if ((first === "projects" || first === "me") && !second) return { name: first };
  if ((first === "mr" || first === "pr") && second && !rest.length) {
    return { name: "lookup", ref: { ...parseRef(second.replace(/^[#!]/, "")), kind: "mr" } };
  }
  if (!second) return { name: "lookup", ref: parseRef(first) };
  throw new CliError(`Unexpected argument "${second}". See gitgumbo --help.`, EXIT.USAGE);
}

// GitGumbo mints "ggb_" + base64url; anything else in the value is a paste error.
const TOKEN_SHAPE = /^ggb_[A-Za-z0-9_-]+$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Read and check GITGUMBO_TOKEN and GITGUMBO_URL. No message repeats the token,
 * and none repeats more of the URL than its origin.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ token: string, baseUrl: string }}  baseUrl: origin + path, no trailing slash
 */
export function config(env) {
  const rawUrl = env.GITGUMBO_URL?.trim() || DEFAULT_URL;
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new CliError("GITGUMBO_URL is not a URL.", EXIT.USAGE);
  }
  if (u.username || u.password) {
    throw new CliError("GITGUMBO_URL must not contain a user name or password.", EXIT.USAGE);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) {
    throw new CliError("GITGUMBO_URL must be https (http only for localhost).", EXIT.USAGE);
  }
  if (u.search || u.hash || rawUrl.includes("?") || rawUrl.includes("#")) {
    throw new CliError("GITGUMBO_URL must not contain a query (?) or fragment (#).", EXIT.USAGE);
  }
  const baseUrl = u.origin + u.pathname.replace(/\/+$/, "");

  const token = env.GITGUMBO_TOKEN?.trim();
  if (!token) {
    throw new CliError(
      `GITGUMBO_TOKEN is not set. Create a token at ${u.origin}/settings/api, then: export GITGUMBO_TOKEN=ggb_...`,
      EXIT.USAGE);
  }
  if (!token.startsWith("ggb_")) {
    throw new CliError("GITGUMBO_TOKEN does not look like a GitGumbo API token (they start with ggb_).", EXIT.USAGE);
  }
  if (!TOKEN_SHAPE.test(token)) {
    throw new CliError(
      "GITGUMBO_TOKEN contains characters a GitGumbo API token never has. Copy it again, or create a new one.",
      EXIT.USAGE);
  }
  return { token, baseUrl };
}

const splitList = (s) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

function print(stream, text) {
  stream.write(text + "\n");
  return EXIT.OK;
}
