import { test } from "node:test";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import {
  run, validate, assertMatchesSpec, project, issue, mr, mrCompact, column, board, page, me, person,
} from "./support.js";
import { parseRef } from "../src/lookup.js";

const gitlab = project();
const github = project({
  id: "proj_gh", provider: "github", name: "api", nameWithNamespace: "acme/api",
  pathWithNamespace: "acme/api", webUrl: "https://github.com/acme/api", remoteProjectId: "99",
});
const paths = (calls) => calls.map((c) => c.url.pathname.replace("/api/v1", "") + (c.url.search || ""));
const ANSI = /\x1b\[/;

// --- The fixtures themselves --------------------------------------------------

test("every builder produces a body the published API schema accepts", () => {
  assertMatchesSpec("/api/v1/projects", page([gitlab, github]));
  assertMatchesSpec("/api/v1/projects/x/board", board([column("Doing", [issue()])]));
  assertMatchesSpec("/api/v1/projects/x/issues", page([issue()]));
  assertMatchesSpec("/api/v1/projects/x/merge-requests", page([mr()]));
  assertMatchesSpec("/api/v1/me", me());
});

test("the schema check is strict: an invented or missing field fails", () => {
  assert.throws(() => assertMatchesSpec("/api/v1/projects/x/issues", page([issue({ column: "Doing" })])), /column: not in the API schema/);
  const { title, ...untitled } = mr();
  assert.throws(() => assertMatchesSpec("/api/v1/projects/x/merge-requests", page([untitled])), /title: missing/);
  assert.deepEqual(validate({ type: ["string", "null"] }, 3), ["$: expected string|null, got integer"]);
});

// --- Issue lookup -----------------------------------------------------------

test("an issue on the board: column, state, assignees and full MR health", async () => {
  const { code, out, calls } = await run(["211"], {
    routes: {
      "/projects": page([gitlab]),
      "/projects/proj_gl/board": board([column("To do"), column("In review", [issue()])]),
      "/projects/proj_gl/merge-requests": page([mr({ number: 999 }), mr()]),
    },
  });
  assert.equal(code, 0);
  assert.match(out, /#211 {2}Login redirect loops after session expiry {2}GitLab acme\/web/);
  assert.match(out, /In review · open · @alice/);
  assert.match(out, /!305 {2}Fix redirect loop on expired session/);
  assert.match(out, /open · pipeline failed · conflicts · 2 unresolved threads · changes requested by @bob/);
  assert.doesNotMatch(out, ANSI, "no colour when stdout is not a TTY");
  assert.deepEqual(paths(calls), [
    "/projects?limit=100",
    "/projects/proj_gl/board",
    "/projects/proj_gl/merge-requests?state=opened&linked=true&limit=100",
  ], "the board answers it: no issue scan");
});

test("sends the token as a Bearer header", async () => {
  const { calls } = await run(["me"], { routes: { "/me": me() } });
  assert.equal(calls[0].init.headers.Authorization, "Bearer ggb_test");
  assert.equal(calls[0].url.origin, "https://gg.test");
});

test("a closed issue falls back to the issue list and skips MR details", async () => {
  const closed = issue({
    state: "closed", assignees: [],
    linkedMergeRequests: [mrCompact({ state: "merged", pipelineStatus: "success", reviewState: "approved" })],
  });
  const { code, out, calls } = await run(["#211"], {
    routes: {
      "/projects": page([gitlab]),
      "/projects/proj_gl/board": board([column("Doing", [issue({ number: 7 })])]),
      "/projects/proj_gl/issues": page([issue({ number: 300 }), closed]),
    },
  });
  assert.equal(code, 0);
  assert.match(out, /off the board · closed · unassigned/);
  assert.match(out, /!305 .*\n {4}merged$/m);
  assert.ok(!paths(calls).some((p) => p.includes("merge-requests")), "merged MRs need no detail call");
  assert.ok(paths(calls).includes("/projects/proj_gl/issues?state=all&limit=100"));
});

test("pages through the issue list with the cursor", async () => {
  const { code, out, calls } = await run(["211"], {
    routes: {
      "/projects": page([gitlab]),
      "/projects/proj_gl/board": board([]),
      "/projects/proj_gl/issues": (url) => url.searchParams.get("cursor") === "c1"
        ? page([issue({ linkedMergeRequests: [] })])
        : page([issue({ number: 1 })], "c1"),
    },
  });
  assert.equal(code, 0);
  assert.match(out, /not on the "Development" board · open/);
  assert.match(out, /no linked MRs/);
  assert.equal(calls.filter((c) => c.url.pathname.endsWith("/issues")).length, 2);
});

test("a hidden board (board: null, no columns) still finds the issue", async () => {
  const { code, out } = await run(["211"], {
    routes: {
      "/projects": page([gitlab]),
      "/projects/proj_gl/board": board([], { board: null }),
      "/projects/proj_gl/issues": page([issue({ linkedMergeRequests: [] })]),
    },
  });
  assert.equal(code, 0);
  assert.match(out, /not on the board · open/);
});

test("a number in both a GitLab and a GitHub project shows both, labelled", async () => {
  const ghIssue = issue({
    title: "Rate limit headers missing", webUrl: "https://github.com/acme/api/issues/211",
    issueType: null, confidential: null,
    linkedMergeRequests: [mrCompact({ number: 212, title: "Add headers", pipelineStatus: "success", reviewState: "approved", pipelineStartedAt: null })],
  });
  const { code, out } = await run(["211"], {
    routes: {
      "/projects": page([gitlab, github]),
      "/projects/proj_gl/board": board([column("In review", [issue({ linkedMergeRequests: [] })])]),
      "/projects/proj_gh/board": board([column("Ready", [ghIssue])], { board: null }),
      "/projects/proj_gh/merge-requests": page([mr({
        number: 212, title: "Add headers", pipelineStatus: "success", reviewState: "approved",
        pipelineStartedAt: null, hasConflicts: false, unresolvedThreads: 0,
        approvedBy: [person("dana")], changesRequestedBy: [],
      })]),
    },
  });
  assert.equal(code, 0);
  assert.match(out, /#211 {2}Login redirect loops.*GitLab acme\/web/);
  assert.match(out, /#211 {2}Rate limit headers missing {2}GitHub acme\/api/);
  assert.match(out, /PR #212 {2}Add headers/);
  assert.match(out, /pipeline success · no conflicts · threads resolved · approved by @dana/);
});

// --- Merge request lookup ---------------------------------------------------

for (const args of [["!305"], ["mr", "305"]]) {
  test(`${args.join(" ")} finds the merge request`, async () => {
    const { code, out, calls } = await run(args, {
      routes: {
        "/projects": page([gitlab, github]),
        "/projects/proj_gl/merge-requests": page([mr({ number: 1 }), mr()]),
        "/projects/proj_gh/merge-requests": page([]),
      },
    });
    assert.equal(code, 0);
    assert.match(out, /^!305 {2}Fix redirect loop on expired session {2}GitLab acme\/web$/m);
    assert.match(out, /fix\/redirect-loop → main/);
    assert.match(out, /reviewers @bob/);
    assert.ok(paths(calls).includes("/projects/proj_gl/merge-requests?state=all&limit=100"));
    assert.ok(!paths(calls).some((p) => p.includes("/board")));
  });
}

// --- Project selection --------------------------------------------------------

test("--project narrows the search; GITGUMBO_PROJECT is the default", async () => {
  const routes = {
    "/projects": page([gitlab, github]),
    "/projects/proj_gh/board": board([column("Ready", [issue({ linkedMergeRequests: [] })])]),
  };
  for (const opts of [{ args: ["211", "-p", "acme/api"] }, { args: ["211"], env: { GITGUMBO_PROJECT: "API" } }]) {
    const { code, calls } = await run(opts.args, { routes, env: opts.env });
    assert.equal(code, 0);
    assert.ok(!paths(calls).some((p) => p.includes("proj_gl")), "the GitLab project is not searched");
  }
});

test("an unknown --project is a usage error that lists the real ones", async () => {
  const { code, err } = await run(["211", "-p", "nope"], { routes: { "/projects": page([gitlab, github]) } });
  assert.equal(code, 2);
  assert.match(err, /No project matches "nope". Your projects: acme\/web, acme\/api/);
});

test("not found: exit 1, says what was searched and that the scan was capped", async () => {
  const { code, out, err } = await run(["211"], {
    routes: {
      "/projects": page([gitlab]),
      "/projects/proj_gl/board": board([]),
      "/projects/proj_gl/issues": (url) => page([issue({ number: 1 })], `c${url.searchParams.get("cursor") ?? 0}x`),
    },
  });
  assert.equal(code, 1);
  assert.equal(out, "");
  assert.match(err, /Issue #211 not found in acme\/web\. Only the 500 most recently updated issues were searched in acme\/web\. .*try '!211'/);
});

// --- Errors -------------------------------------------------------------------

test("a missing token is exit 2 and makes no request", async () => {
  const { code, err, calls } = await run(["211"], { env: { GITGUMBO_TOKEN: "" } });
  assert.equal(code, 2);
  assert.match(err, /GITGUMBO_TOKEN is not set\. Create a token at https:\/\/gg\.test\/settings\/api/);
  assert.equal(calls.length, 0);
});

const apiError = (status, code, message, headers) => ({ status, body: { error: { code, message } }, headers });

test("401 and 402 are exit 3 with the API's code", async () => {
  let r = await run(["211"], { routes: { "/projects": apiError(401, "token_revoked", "This token has been revoked") } });
  assert.equal(r.code, 3);
  assert.match(r.err, /Token rejected \(token_revoked\): This token has been revoked\./);
  r = await run(["211"], { routes: { "/projects": apiError(402, "api_requires_pro", "API access requires a Pro plan") } });
  assert.equal(r.code, 3);
  assert.match(r.err, /requires a Pro plan \(api_requires_pro\)/);
});

test("429 is exit 4 and shows the Retry-After", async () => {
  const { code, err } = await run(["211"], {
    routes: { "/projects": apiError(429, "rate_limited", "API rate limit exceeded", { "Retry-After": "754" }) },
  });
  assert.equal(code, 4);
  assert.match(err, /Rate limit exceeded \(rate_limited\)\. Try again in 12m 34s\./);
});

test("503 (rate limiter down) is exit 4 too", async () => {
  const { code, err } = await run(["me"], { routes: { "/me": apiError(503, "unavailable", "x", { "Retry-After": "60" }) } });
  assert.equal(code, 4);
  assert.match(err, /temporarily unavailable \(unavailable\)\. Try again in 1m 0s/);
});

test("a 404 mid-lookup is exit 1", async () => {
  const { code, err } = await run(["211"], {
    routes: { "/projects": page([gitlab]), "/projects/proj_gl/board": apiError(404, "not_found", "Project not found") },
  });
  assert.equal(code, 1);
  assert.match(err, /Not found \(not_found\): Project not found/);
});

test("a network failure is exit 5", async () => {
  const down = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  const { code, err } = await run(["211"], { routes: { "/projects": down } });
  assert.equal(code, 5);
  assert.match(err, /Could not reach https:\/\/gg\.test: ECONNREFUSED/);
});

test("bad arguments are exit 2", async () => {
  for (const args of [[], ["abc"], ["211", "212"], ["--bogus"]]) {
    assert.equal((await run(args)).code, 2, args.join(" "));
  }
});

// --- Output modes -------------------------------------------------------------

const onBoard = {
  "/projects": page([gitlab]),
  "/projects/proj_gl/board": board([column("Doing", [issue()])]),
  "/projects/proj_gl/merge-requests": page([mr()]),
};

test("colour on a TTY, and off with NO_COLOR or --no-color", async () => {
  assert.match((await run(["211"], { routes: onBoard, tty: true })).out, ANSI);
  assert.doesNotMatch((await run(["211"], { routes: onBoard, tty: true, env: { NO_COLOR: "1" } })).out, ANSI);
  assert.doesNotMatch((await run(["211", "--no-color"], { routes: onBoard, tty: true })).out, ANSI);
});

test("--json prints the API objects, with the column", async () => {
  const { code, out } = await run(["211", "--json"], { routes: onBoard, tty: true });
  assert.equal(code, 0);
  const result = JSON.parse(out);
  assert.equal(result.matches[0].column, "Doing");
  assert.equal(result.matches[0].issue.number, 211);
  assert.equal(result.matches[0].mergeRequests[0].unresolvedThreads, 2);
  assert.deepEqual(result.ref, { kind: "issue", number: 211 });
});

test("--json errors are JSON on stdout as well", async () => {
  const { code, out } = await run(["211", "--json"], {
    routes: { "/projects": apiError(429, "rate_limited", "x", { "Retry-After": "5" }) },
  });
  assert.equal(code, 4);
  assert.deepEqual(JSON.parse(out).error, { message: "Rate limit exceeded (rate_limited). Try again in 5s.", exitCode: 4, status: 429, code: "rate_limited", retryAfter: 5 });
});

test("projects and me", async () => {
  let r = await run(["projects"], { routes: { "/projects": page([gitlab, github]) } });
  assert.match(r.out, /^acme\/web {2}GitLab · id proj_gl\nacme\/api {2}GitHub · id proj_gh\n$/);
  r = await run(["me"], { routes: { "/me": me() } });
  assert.match(r.out, /^Acme {2}pro plan\ntoken "laptop" \(read\), expires 2027-01-31\nrate limit 994\/1000 left/);
});

test("parseRef", () => {
  assert.deepEqual(parseRef("211"), { kind: "issue", number: 211 });
  assert.deepEqual(parseRef("#211"), { kind: "issue", number: 211 });
  assert.deepEqual(parseRef("!305"), { kind: "mr", number: 305 });
  for (const bad of ["", "#", "0", "2.5", "#!3", "abc"]) assert.throws(() => parseRef(bad), /Not an issue or MR reference/);
});

// --- Control characters in API text ------------------------------------------

// ESC, CR, a C1 CSI and RIGHT-TO-LEFT OVERRIDE: none may reach the terminal raw.
const NASTY = "\x1b[2J\r\u009b31m‮";
const RAW_CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f‎‏؜‪-‮⁦-⁩]/;
const withoutColour = (s) => s.replace(/\x1b\[\d+m/g, "");

const nastyRoutes = {
  "/projects": page([project({ name: `web${NASTY}`, pathWithNamespace: `acme/web${NASTY}` })]),
  "/projects/proj_gl/merge-requests": page([mr({
    title: `Fix${NASTY}it`, sourceBranch: `fix/${NASTY}`, targetBranch: `main${NASTY}`,
    reviewers: [person(`bob${NASTY}`)],
  })]),
};

test("control characters in API text are replaced before printing, coloured or not", async () => {
  for (const opts of [{}, { tty: true }, { tty: true, args: ["--no-color"] }]) {
    const { code, out } = await run(["!305", ...(opts.args ?? [])], { routes: nastyRoutes, tty: opts.tty });
    assert.equal(code, 0);
    assert.doesNotMatch(withoutColour(out), RAW_CONTROL, JSON.stringify(opts));
    assert.match(out, /Fix�\[2J��31m�it/);
    assert.match(out, /fix\/�/);
    assert.match(out, /reviewers @bob�/);
    assert.match(out, /acme\/web�/);
  }
  const r = await run(["211"], {
    routes: {
      "/projects": page([gitlab]),
      "/projects/proj_gl/board": board([column(`Doing${NASTY}`, [issue({
        title: `Login${NASTY}`, linkedMergeRequests: [], assignees: [person(null, `Al${NASTY}`)],
      })])]),
    },
  });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, RAW_CONTROL);
  assert.match(r.out, /#211 {2}Login�/);
  assert.match(r.out, /Doing�.* · open · Al�/);
});

test("control characters in an API error message are replaced on stderr", async () => {
  const { code, err } = await run(["211"], {
    routes: { "/projects": page([gitlab]), "/projects/proj_gl/board": apiError(404, `nf${NASTY}`, `Gone${NASTY}`) },
  });
  assert.equal(code, 1);
  assert.doesNotMatch(err, RAW_CONTROL);
  assert.match(err, /Not found \(nf�.*\): Gone�/);
});

test("--json keeps API text unchanged as a value but prints no raw control characters", async () => {
  const { code, out } = await run(["!305", "--json"], { routes: nastyRoutes });
  assert.equal(code, 0);
  assert.doesNotMatch(out, RAW_CONTROL);
  const { mergeRequest } = JSON.parse(out).matches[0];
  assert.equal(mergeRequest.title, `Fix${NASTY}it`);
  assert.equal(mergeRequest.sourceBranch, `fix/${NASTY}`);

  const e = await run(["211", "--json"], {
    routes: { "/projects": page([gitlab]), "/projects/proj_gl/board": apiError(404, "not_found", `Gone${NASTY}`) },
  });
  assert.doesNotMatch(e.out, RAW_CONTROL);
  assert.equal(JSON.parse(e.out).error.message, `Not found (not_found): Gone${NASTY}`);
  assert.doesNotMatch(e.err, RAW_CONTROL);
});

// --- Configuration checks -------------------------------------------------------

test("a token with characters a token never has is exit 2, not echoed, and sends nothing", async () => {
  for (const bad of ["ggb_secretA\r\nX-Evil: 1", "ggb_secretA\nB", "ggb_secret\0A", "ggb_secret A", "ggb_secret!A"]) {
    const { code, err, out, calls } = await run(["me", "--json"], { env: { GITGUMBO_TOKEN: bad }, routes: { "/me": me() } });
    assert.equal(code, 2, JSON.stringify(bad));
    assert.match(err, /GITGUMBO_TOKEN contains characters a GitGumbo API token never has/);
    assert.doesNotMatch(err + out, /secret/, "the token value is never printed");
    assert.equal(calls.length, 0);
  }
  assert.equal((await run(["me"], { env: { GITGUMBO_TOKEN: "ggb_Ab-9_z" }, routes: { "/me": me() } })).code, 0);
});

test("an error thrown before the request is sent is not echoed", async () => {
  const early = new TypeError('Headers.append: "Bearer ggb_secret\nx" is an invalid header value.');
  const { code, err } = await run(["me"], { routes: { "/me": early } });
  assert.equal(code, 5);
  assert.match(err, /Could not send the request to https:\/\/gg\.test\./);
  assert.doesNotMatch(err, /secret|Bearer/);
});

test("a credential quoted in a network error's cause is redacted", async () => {
  const down = Object.assign(new TypeError("fetch failed"), { cause: { message: "bad: Bearer ggb_secret" } });
  const { code, err } = await run(["me"], { routes: { "/me": down } });
  assert.equal(code, 5);
  assert.doesNotMatch(err, /secret/);
  assert.match(err, /Bearer \[redacted\]/);
});

test("a user name or password in GITGUMBO_URL is exit 2 and not echoed", async () => {
  for (const url of ["https://alice:hunter2@gg.test", "https://hunter2@gg.test", "https://:hunter2@gg.test"]) {
    const { code, err, calls } = await run(["me"], { env: { GITGUMBO_URL: url }, routes: { "/me": me() } });
    assert.equal(code, 2, url);
    assert.match(err, /must not contain a user name or password/);
    assert.doesNotMatch(err, /hunter2|alice/);
    assert.equal(calls.length, 0);
  }
});

test("messages name the server by its origin only", async () => {
  const r = await run(["me"], {
    env: { GITGUMBO_URL: "https://gg.test/" },
    routes: { "/me": apiError(401, "token_revoked", "revoked") },
  });
  assert.equal(r.code, 3);
  assert.match(r.err, /Create a new one at https:\/\/gg\.test\/settings\/api\./);
  const n = await run(["me"], { env: { GITGUMBO_URL: "https://gg.test/", GITGUMBO_TOKEN: "" } });
  assert.match(n.err, /Create a token at https:\/\/gg\.test\/settings\/api,/);
});

test("GITGUMBO_URL must be https, except http on loopback", async () => {
  for (const url of ["http://gg.test", "ftp://gg.test", "file:///etc/passwd", "javascript:alert(1)", "http://10.0.0.1"]) {
    const { code, err, calls } = await run(["me"], { env: { GITGUMBO_URL: url }, routes: { "/me": me() } });
    assert.equal(code, 2, url);
    assert.match(err, /GITGUMBO_URL must be https/);
    assert.equal(calls.length, 0);
  }
  for (const url of ["http://localhost:3033", "http://127.0.0.1:3033", "http://[::1]:3033", "https://gg.test"]) {
    const { code, calls } = await run(["me"], { env: { GITGUMBO_URL: url }, routes: { "/me": me() } });
    assert.equal(code, 0, url);
    assert.equal(calls[0].url.href, `${url}/api/v1/me`);
  }
});

test("a query or fragment in GITGUMBO_URL is exit 2; a path is kept", async () => {
  for (const url of ["https://gg.test/?x=1", "https://gg.test?", "https://gg.test/#frag", "https://gg.test#"]) {
    const { code, err, calls } = await run(["me"], { env: { GITGUMBO_URL: url }, routes: { "/me": me() } });
    assert.equal(code, 2, url);
    assert.match(err, /must not contain a query \(\?\) or fragment \(#\)/);
    assert.equal(calls.length, 0);
  }
  const { calls } = await run(["me"], { env: { GITGUMBO_URL: "https://gg.test/gitgumbo/" } });
  assert.equal(calls[0].url.href, "https://gg.test/gitgumbo/api/v1/me");
});

// --- Redirects --------------------------------------------------------------------

test("requests refuse redirects", async () => {
  const { calls } = await run(["me"], { routes: { "/me": me() } });
  assert.equal(calls[0].init.redirect, "error");
});

test("a redirect from the server is a clear error, not followed (real fetch, loopback stub)", async (t) => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    res.writeHead(302, { location: "http://127.0.0.1:9/elsewhere" }).end();
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { main } = await import("../src/cli.js");
  let out = "", err = "";
  const code = await main({
    argv: ["me"],
    env: { GITGUMBO_TOKEN: "ggb_test", GITGUMBO_URL: `http://127.0.0.1:${server.address().port}` },
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  assert.equal(code, 5);
  assert.match(err, /answered with a redirect, which the GitGumbo API never does\. Check GITGUMBO_URL\./);
  assert.equal(hits, 1);
  assert.equal(out, "");
});

// --- One project failing ------------------------------------------------------------

test("a project that fails stops new requests but keeps a match found elsewhere", async () => {
  const names = ["one", "two", "three", "four", "five", "six"];
  const projects = names.map((n) => project({ id: `p_${n}`, name: n, nameWithNamespace: `Acme / ${n}`, pathWithNamespace: `acme/${n}` }));
  const routes = { "/projects": page(projects) };
  for (const n of names) {
    routes[`/projects/p_${n}/board`] = board([]);
    routes[`/projects/p_${n}/issues`] = page([]);
  }
  // one: found by the issue scan (2 requests); two: fails on its first request.
  routes["/projects/p_one/issues"] = page([issue({ linkedMergeRequests: [] })]);
  routes["/projects/p_two/board"] = apiError(500, "internal", "boom");

  const { code, out, err, calls } = await run(["211"], { routes });
  assert.equal(code, 0, err);
  assert.match(out, /#211 {2}Login redirect loops after session expiry {2}GitLab acme\/one/);
  assert.match(err, /warning: could not search acme\/two: GitGumbo API error 500 \(internal\): boom/);
  assert.match(err, /not searched after that error: acme\/five, acme\/six/);
  const started = paths(calls).filter((p) => p.endsWith("/board")).map((p) => p.split("/")[2]);
  assert.deepEqual(started, ["p_one", "p_two", "p_three", "p_four"], "no project is started after the error");

  const j = await run(["211", "--json"], { routes });
  assert.equal(j.code, 0);
  const result = JSON.parse(j.out);
  assert.deepEqual(Object.keys(result), ["ref", "matches", "searched", "incomplete"]);
  assert.deepEqual(result.searched, ["acme/one", "acme/three", "acme/four"]);
});

test("a project that fails with no match anywhere is reported as the error", async () => {
  const two = project({ id: "p_two", name: "two", nameWithNamespace: "Acme / two", pathWithNamespace: "acme/two" });
  const { code, err } = await run(["211"], {
    routes: {
      "/projects": page([gitlab, two]),
      "/projects/proj_gl/board": board([]),
      "/projects/proj_gl/issues": page([]),
      "/projects/p_two/board": apiError(500, "internal", "boom"),
    },
  });
  assert.equal(code, 5);
  assert.match(err, /GitGumbo API error 500 \(internal\): boom/);
  assert.doesNotMatch(err, /warning/);
});

// --- Draft merge requests -----------------------------------------------------------

test("a draft MR shows its state as well as the draft mark", async () => {
  const r = await run(["211"], {
    routes: {
      "/projects": page([gitlab]),
      "/projects/proj_gl/board": board([], { board: null }),
      "/projects/proj_gl/issues": page([issue({
        state: "closed",
        linkedMergeRequests: [mrCompact({ state: "merged", draft: true }), mrCompact({ number: 306, state: "closed", draft: true })],
      })]),
    },
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /!305 .*\n {4}merged · draft$/m);
  assert.match(r.out, /!306 .*\n {4}closed · draft$/m);

  const o = await run(["!305"], {
    routes: { "/projects": page([gitlab]), "/projects/proj_gl/merge-requests": page([mr({ draft: true })]) },
  });
  assert.match(o.out, /^ {2}open · draft · pipeline failed · conflicts/m);
});

// --- --json usage errors -------------------------------------------------------------

test("--json with a bad argument still prints the JSON error", async () => {
  for (const args of [["--json", "--bogus"], ["--bogus", "--json"], ["211", "--json", "-x"]]) {
    const { code, out, err } = await run(args);
    assert.equal(code, 2, args.join(" "));
    const { error } = JSON.parse(out);
    assert.equal(error.exitCode, 2);
    assert.match(error.message, /Unknown option/);
    assert.match(err, /Unknown option/);
  }
});
