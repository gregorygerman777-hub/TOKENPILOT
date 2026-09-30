# TokenPilot

**Spend tokens on fixing, not finding.** TokenPilot finds security issues with local scanners, hands Claude the exact code to fix instead of letting it explore, and keeps a patch only when the evidence says the fix holds.

Created by Gregory German, freshman computer science student. 100% open source under the MIT license and free. Claude usage for repairs is billed by your own provider account.

![TokenPilot Security Lab scanning a demo project: 4 findings, 0 model tokens](docs/screens/security-lab.png)

## The problem

Most of what a coding agent spends goes into looking: listing files, searching, re-reading the same section, re-running a check that already failed. Scanners are the opposite. They find issues for free but never fix them. And when an agent does return a fix, a plausible diff is not the same as proof that the issue is gone.

TokenPilot holds itself to two rules:

- **No model tokens for work plain code can do.** Finding issues, locating the affected function, collecting its callers and tests, and choosing the checks are all deterministic.
- **A fix counts only with evidence.** The project's checks pass, the finding is gone on rescan, nothing new appears and no test was edited. Anything else is reverted.

## How it works

```mermaid
flowchart LR
    T["Target<br/>local Git project"] --> S["Snapshot<br/>file hashes, commit"]
    S --> D["Detect<br/>Semgrep + Gitleaks<br/>0 model tokens"]
    D --> B["Diagnose<br/>repair brief<br/>0 model tokens"]
    B --> R["Repair<br/>budgeted Claude Code session"]
    R --> V["Verify<br/>checks, rescan, gate"]
    V -->|verified| P["fixes.patch + trust report<br/>you review and apply"]
    V -->|rejected| X["reverted"]
```

1. **Snapshot** copies the source into private storage with a hash for every file and the Git commit, so every later comparison is against exactly what was scanned.
2. **Detect** runs Semgrep with a bundled rule pack and Gitleaks with full redaction. No model call.
3. **Diagnose** turns each rule/file group into a repair brief: the enclosing function with line numbers, other references, related tests, the project's checks and a fix direction. No model call, and secret values never enter a brief.
4. **Repair** starts a Claude Code session from the brief, with bounded tools, a compact system prompt and hard limits on tool calls, repeats, time and spend.
5. **Verify** reruns the checks, rescans against the snapshot and applies a plain-code gate. It rejects remaining findings, new findings, suppression comments and edited tests.

![A repair brief handed to Claude in the desktop app](docs/screens/repair-brief.png)

## What makes it different

- **Finding costs nothing.** Detection and diagnosis never call a model.
- **Claude starts at the right line.** The brief replaces the search-and-read phase of a repair.
- **Budgets are enforced, not suggested.** Tool calls, repeated actions and elapsed time are blocked locally. Spend uses Claude Code's own `--max-budget-usd`.
- **The gate is code, not a model's opinion.** No agent can mark its own work verified.
- **Your repository is never touched.** `tokenpilot repair` works on a private clone and gives you a patch of verified fixes to review.
- **Unmeasured means unmeasured.** Savings, reproduction and review steps that did not run are shown that way, never as a pass.

## Results

| Measurement | Result | Scope |
|---|---|---|
| Model tokens to detect and diagnose | **0** | Every scan. Scanners and briefs are deterministic. |
| Coding controller vs. stock prompt | **69.0% fewer tokens** | 8 matched pairs on 4 small synthetic tasks, same model and effort. 5 attempts without final usage stay in the record. [Details](BENCHMARK.md) |
| Repair brief vs. one-sentence handoff | **Not yet measured** | `node benchmark/brief.cjs` repairs the same scanner findings both ways with everything else held equal. |

The 69.0% figure covers general coding tasks, not repairs of scanner findings. No savings number for repairs is claimed until the brief study has run.

## Screens

The browser workbench runs on your Mac and uses the same scanner backend and history as the desktop app.

![Browser workbench with 4 static findings on a demo project](docs/screens/web-workbench.png)

## Tech stack

| Layer | What it uses |
|---|---|
| Language | JavaScript (Node.js 22+, CommonJS), no build step |
| Agent | Claude Code CLI in stream-json mode, with TokenPilot's bounded tools over the official MCP SDK |
| Detection | Semgrep with a bundled rule pack, Gitleaks with full redaction |
| Desktop | Electron with context isolation and a strict content security policy |
| Web | Local Node HTTP server bound to 127.0.0.1 with a per-session bearer token |
| Storage | Local JSON and snapshots under `~/Library/Application Support/TokenPilot` |
| Tests | `node:test` and Playwright |

## Getting started

### Prerequisites

- macOS (the desktop build targets Apple Silicon; the CLI and web workbench run anywhere Node does)
- Node.js 22 or newer, npm and Git
- Semgrep and Gitleaks: `brew install semgrep gitleaks`
- For repairs only: Claude Code, signed in with `claude auth login`

### Install

```sh
git clone https://github.com/gregorygerman777-hub/TOKENPILOT.git
cd TOKENPILOT
npm ci
```

### Run

```sh
npm run web                                   # browser workbench, open http://127.0.0.1:8792
node src/cli.cjs repair /path/to/git-project --output /tmp/pilot-repair
npm start                                     # desktop app
claude --plugin-dir "$(pwd)"                  # Claude Code plugin: /tokenpilot:scan <path>
```

Open the workbench at `127.0.0.1`, not `localhost`: the server only accepts its exact address. `repair` writes `report.html`, `fixes.patch` and `run.json` to the output folder.

### CLI reference

| Command | What it does |
|---|---|
| `scan <path> [--baseline <run-id>]` | Scan a folder or file. Exit 0 clean, 1 findings, 2 incomplete. |
| `repair <git-project> --output <dir>` | Scan, brief, repair, verify on a private clone. Writes a trust report and a verified-only patch. |
| `ci <path> [--baseline <evidence.json>]` | CI gate that separates existing baseline debt from new findings. |
| `report <run-id> [out.html]` | Self-contained HTML report for a scan. |
| `demo <new-dir>` | Before/after demo with a fixed repair recipe and no AI calls. |
| `history`, `doctor`, `serve [port]` | Scan history, scanner check, browser workbench. |

### Develop

```sh
npm test            # unit and integration tests; live scanner tests run when Semgrep and Gitleaks are installed
npm run test:ui     # desktop UI checks
node benchmark/brief.cjs   # paid study: brief vs. one-sentence repair handoff
```

## Repository layout

| Path | What's there |
|---|---|
| `src/security.cjs` | Snapshot, scanners, grouping, comparison and the scoped gate |
| `src/diagnose.cjs` | Repair briefs |
| `src/pipeline.cjs`, `src/trust.cjs` | The repair pipeline and the trust report |
| `src/engine.cjs`, `policy.cjs`, `verify.cjs` | The budgeted agent controller, limits and check runner |
| `src/claude.cjs`, `src/bridge.mjs` | Claude Code adapter and the bounded MCP tools |
| `src/security-mcp.mjs`, `skills/` | The Claude Code plugin |
| `src/server.cjs`, `web/` | Browser workbench |
| `src/main.cjs`, `ui/` | Electron desktop app |
| `benchmark/` | Paid-provider studies with independent acceptance checks and raw run logs |
| `test/` | Unit, integration, MCP and UI tests |

## Safety

- The web server binds to 127.0.0.1 only and requires a random session token, exact Host matching and same-origin requests.
- Gitleaks always runs with full redaction, and briefs withhold secret values entirely.
- Source excerpts and scanner output are passed to Claude as untrusted data, never as instructions.
- Repair sessions can only use TokenPilot's bounded tools. Arbitrary commands need your approval, and tests and check configuration are locked during security repairs.
- Scanner-cleared means the rules stopped matching. It is not a reproduced exploit or proof that behavior is safe. An independent AI reviewer is not implemented and is never implied.

## More documentation

- [`docs/GUIDE.md`](docs/GUIDE.md): the desktop app, Security Lab, limits, configuration and privacy in full
- [`docs/WEB.md`](docs/WEB.md): the browser workbench
- [`docs/CLAUDE.md`](docs/CLAUDE.md): the Claude Code plugin
- [`docs/CI.md`](docs/CI.md): the CI gate
- [`BENCHMARK.md`](BENCHMARK.md) and [`docs/VALIDATION.md`](docs/VALIDATION.md): measurements and what was tested
- [`CONTRIBUTING.md`](CONTRIBUTING.md), [`SECURITY.md`](SECURITY.md), [`CHANGELOG.md`](CHANGELOG.md)
