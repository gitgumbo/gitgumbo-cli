# gitgumbo-cli

Answer the stand-up question without opening a browser: **where is issue #211, and how are its merge requests doing?**

[GitGumbo](https://gitgumbo.com) is a kanban board over your GitLab and GitHub issues. This is a small, read-only command-line client for its public API. It has no dependencies and needs Node 18.3 or later.

```console
$ gitgumbo 211
#211  Login redirect loops after session expiry  GitLab acme/web
  In review · open · @alice @bob
  https://gitlab.com/acme/web/-/issues/211

  !305  Fix redirect loop on expired session
    open · pipeline failed · conflicts · 2 unresolved threads · changes requested by @bob

  !298  Draft: Cover expiry in e2e
    draft · pipeline running · no conflicts · threads resolved · review pending

#211  Rate-limit headers missing on 404  GitHub acme/api
  Ready to ship · open · @dana
  https://github.com/acme/api/issues/211

  PR #214  Send rate-limit headers on every response
    open · pipeline success · no conflicts · threads resolved · approved by @erin
```

A number that exists in more than one project shows every match, labelled with the provider and project.

## Install

> **Not published yet.** Neither command below works until the package is on npm.

```sh
npx gitgumbo-cli 211          # one-off
npm install -g gitgumbo-cli   # installs the `gitgumbo` command
```

Until then, from a clone: `npm link`, or run `node bin/gitgumbo.js 211`.

### Why `gitgumbo` and not `gg`

`gg` is already taken by well-known tools: [gg-scm/gg](https://github.com/gg-scm/gg), a Git CLI, and [gulbanana/gg](https://github.com/gulbanana/gg), a GUI for Jujutsu that you also start as `gg`. The package does not install a `gg` command. If you have neither tool, add an alias:

```sh
alias gg=gitgumbo   # bash / zsh
alias gg gitgumbo   # fish (add --save to keep it)
```

## Set up a token

1. In GitGumbo, open **/settings/api** and create an API token. It starts with `ggb_` and is shown only once. The API needs a Pro or Team plan.
2. Export it:

```sh
export GITGUMBO_TOKEN=ggb_...
```

| Variable           | Meaning                                                        |
| ------------------ | -------------------------------------------------------------- |
| `GITGUMBO_TOKEN`   | Required. Your API token.                                      |
| `GITGUMBO_URL`     | Optional. Defaults to `https://gitgumbo.com`. Must be https (http only for `localhost`, `127.0.0.1` or `[::1]`), with no user name, password, query or fragment. |
| `GITGUMBO_PROJECT` | Optional. The default project(s) to search, comma-separated.   |
| `NO_COLOR`         | Optional. Set it to turn colour off.                           |

A project is named by its id, its `group/path`, or its name, case-insensitive. `gitgumbo projects` lists yours.

## Usage

```sh
gitgumbo 211                 # issue #211
gitgumbo '#211'              # the same; quote it, because # starts a shell comment
gitgumbo '!305'              # merge request !305 (GitLab) or PR #305 (GitHub)
gitgumbo mr 305              # the same, with no quoting (bash and zsh expand ! even inside double quotes)
gitgumbo 211 -p acme/web     # search one project (repeat -p for several)
gitgumbo 211 --json | jq '.matches[].column'
gitgumbo projects            # your projects, to pick a default
gitgumbo me                  # your firm, plan, token expiry and remaining rate limit
```

For each linked MR or PR you get its state and draft flag, pipeline status, and review state. An **open** one also shows whether it has conflicts, its unresolved thread count, and who approved it or requested changes. Merged and closed ones show their state only.

### `--json`

Prints `{ ref, matches, searched, incomplete }`. Each issue match is `{ project, issue, column, board, mergeRequests }`, and each MR match is `{ project, mergeRequest }`. These are the API's own objects, unchanged. An open linked MR is the full `Mr` object, with `hasConflicts`, `unresolvedThreads` and `approvedBy`. Merged and closed ones are the compact `MrCompact` object. `column` is `null` when the issue is not on the board, for example because it is closed. On an error, `--json` prints `{ error: { message, exitCode, status, code, retryAfter } }` to stdout and the message to stderr.

### Exit codes

| Code | Meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| 0    | Found                                                                   |
| 1    | Not found (no match in the searched projects, or a 404)                 |
| 2    | Usage or configuration error (bad argument, missing token, unknown project) |
| 3    | Token rejected (401: invalid, revoked, expired or orphaned) or no API on this plan (402) |
| 4    | Rate limited (429) or the API's rate limiter is down (503). Shows the Retry-After |
| 5    | Network failure, timeout, or another server error                        |

## How it finds an issue, and what it costs

The GitGumbo API has no issue-by-number endpoint and no cross-project search, so the tool asks each project in turn:

1. `GET /projects/{id}/board` returns every open issue on the board, already placed in its column. Most lookups end here.
2. If the issue isn't on the board (it's closed, or the board is scoped to one assignee), the tool reads `GET /projects/{id}/issues?state=all`. That list is newest activity first, so a recently touched issue is on the first page. The tool stops after 500 issues (5 pages of 100) and says so if it didn't search everything.
3. If the issue has open linked MRs, the tool reads `GET /projects/{id}/merge-requests?state=opened&linked=true` once. The board's compact MR doesn't include conflicts, threads or reviewer names.

`'!305'` reads each project's `merge-requests?state=all`, with the same 500-item cap.

Rate limits are per firm: 1,000 requests an hour on Pro and 5,000 on Team. A typical lookup in one project costs 3 requests (projects, board, MR details). Searching every project costs about 1 + 2 × the number of projects. If your firm has many projects, set `GITGUMBO_PROJECT`.

## Development

```sh
npm test    # node --test, no dependencies
```

The tests stub `fetch`. `test/fixtures/openapi-responses.json` is copied from GitGumbo's published OpenAPI document (`/api/v1/openapi.json`, v1.18.1). Every stubbed response is checked strictly against it, so a fixture with a missing, mistyped or made-up field fails the test.

## License

MIT © 2026 André Shapps
