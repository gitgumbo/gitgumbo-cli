// Argument parsing, configuration and output. Everything the process touches
// (argv, env, fetch, stdout, stderr) is passed in, so tests drive it directly.

import { parseArgs } from "node:util";
import { createClient, CliError, EXIT } from "./api.js";
import { lookup, parseRef } from "./lookup.js";
import { painter, renderLookup, renderMe, renderNotFound, renderProjects } from "./format.js";

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
  GITGUMBO_URL           default ${DEFAULT_URL}
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
  let json = false;
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
      return print(stdout, json ? JSON.stringify(projects, null, 2) : renderProjects(projects, paint));
    }
    if (command.name === "me") {
      const me = await client.get("/me");
      return print(stdout, json ? JSON.stringify(me, null, 2) : renderMe(me, paint));
    }

    const selectors = values.project ?? splitList(env.GITGUMBO_PROJECT);
    const result = await lookup(client, command.ref, selectors);
    if (json) {
      print(stdout, JSON.stringify(result, null, 2));
    } else if (result.matches.length) {
      print(stdout, renderLookup(result, paint));
    } else {
      stderr.write(renderNotFound(result) + "\n");
    }
    return result.matches.length ? EXIT.OK : EXIT.NOT_FOUND;
  } catch (err) {
    const known = err instanceof CliError;
    const code = known ? err.exitCode : err?.code?.startsWith?.("ERR_PARSE_ARGS") ? EXIT.USAGE : EXIT.UNAVAILABLE;
    const message = known || code === EXIT.USAGE ? err.message : `Unexpected error: ${err?.stack ?? err}`;
    if (json) {
      print(stdout, JSON.stringify({ error: { message, exitCode: code, status: err.status, code: err.code, retryAfter: err.retryAfter } }, null, 2));
    }
    stderr.write(`gitgumbo: ${message}\n`);
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

/** @param {Record<string, string | undefined>} env */
export function config(env) {
  const token = env.GITGUMBO_TOKEN?.trim();
  const baseUrl = env.GITGUMBO_URL?.trim() || DEFAULT_URL;
  if (!token) {
    throw new CliError(
      `GITGUMBO_TOKEN is not set. Create a token at ${baseUrl}/settings/api, then: export GITGUMBO_TOKEN=ggb_...`,
      EXIT.USAGE);
  }
  if (!token.startsWith("ggb_")) {
    throw new CliError("GITGUMBO_TOKEN does not look like a GitGumbo API token (they start with ggb_).", EXIT.USAGE);
  }
  try {
    new URL(baseUrl);
  } catch {
    throw new CliError(`GITGUMBO_URL is not a URL: ${baseUrl}`, EXIT.USAGE);
  }
  return { token, baseUrl };
}

const splitList = (s) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

function print(stream, text) {
  stream.write(text + "\n");
  return EXIT.OK;
}
