# TokenPilot guide

The full reference for the desktop app, Security Lab, limits, configuration and privacy. Start with the [README](../README.md) for the overview.

## Try the desktop app

Open the app, choose **Security Lab → Try sample project**. The included sample has two intentionally unsafe patterns. Scanners inspect it without executing the code. No model request is sent. Select **Prepare focused repair** to review a budgeted Claude task before running it.

Scanners are optional external tools:

```sh
brew install semgrep gitleaks
```

The app detects missing tools and records an incomplete scan instead of pretending it passed. The desktop installer requires no Node setup; project verification commands still need their own runtimes.

## Security Lab, precisely

- Source snapshots have file hashes and the available Git commit. Current uncommitted source is included. Generated directories, symlinks and files larger than 4 MB are outside coverage.
- Semgrep runs a bundled, focused Python/JavaScript/TypeScript rule pack. Gitleaks runs its default rules with full secret redaction. No remote rule registry or Semgrep metrics are used. This is a starter rule pack, not a comprehensive security audit.
- Findings group deterministically by rule and file. These are **candidate groups**, not AI-proven common root causes.
- A focused repair must clear its selected group, introduce no new scanner groups/count increases, and pass required project checks. Existing tests and check configuration are protected for security repair sessions. Heuristic suppression/test-detection flags require review.
- **Scanner-cleared** means the static rules stopped matching. It never means an exploit was reproduced or a behavior was proven safe.
- HTML reports are self-contained, escape untrusted markup and include gate outcomes. Pattern-based redaction cannot catch every kind of secret; review reports before sharing. Local source snapshots retain original source and may contain secrets. They stay under the app's private data directory.
- An independent AI Challenger is **not implemented**. It is displayed that way, never as an implied pass.

### Optional frozen Docker probe

In Project rules, add a `proof` object alongside `rules` and `checks`:

```json
{
  "proof": {
    "image": "python:3.12-alpine",
    "runtime": "python3",
    "script": "import sys; sys.path.insert(0, '/workspace'); from app import clamp; assert clamp(-1, 0, 5) == 0"
  }
}
```

The baseline freezes this script. The comparison runs that exact script against both saved snapshots. A behavioral gate requires **exit 1 before**, **exit 0 after**, the same image ID, and the same script hash. Setup failures, missing Docker/images and other exit codes remain unverified. Probes use a locally available image, no network, read-only source/root filesystem, an unprivileged user, dropped capabilities, and resource limits. Images are never pulled automatically. Docker itself and a trusted local image must be installed separately. This machine did not have Docker; the adapter is implemented but live Docker execution has not been validated here. Script quality still matters: a weak probe is not proof of general security.

### CLI

From the source checkout:

```sh
npm ci
node src/cli.cjs doctor
node src/cli.cjs scan ./my-project
node src/cli.cjs history
node src/cli.cjs scan ./my-project --baseline RUN_ID
node src/cli.cjs report RUN_ID report.html
```

`npm link` optionally installs the `tokenpilot` command. Scan exit codes: 0 for a completed clean scan, 1 for completed scans with findings, 2 for incomplete/failed/stopped scans. CLI and desktop scan records are local. No GitHub publishing or automatic merging occurs.

The prior [token benchmark](../BENCHMARK.md) applies to the 1.0 coding controller, not a new security benchmark. This release makes no new savings-percentage claim.


## The desktop controller

An installable, local macOS desktop controller for Claude Code. It reduces unnecessary context with a compact task-specific toolset and a stable, compact system prompt, blocks duplicate work, runs verification locally, and records provider-reported consumption. Codex and Gemini are explicitly unavailable adapters.

## Install on this Mac

This build targets **macOS Apple Silicon (arm64)**. Open `release/TokenPilot-1.2.0-arm64.dmg`, then drag TokenPilot into Applications. A ZIP of the application is also provided. The app is **not Developer ID signed or notarized**. macOS may block it; use System Settings > Privacy & Security > Open Anyway after attempting to open this build. Do not disable Gatekeeper globally.

Claude Code is a separate prerequisite. The integration was tested with **Claude Code 2.1.283** using the user's existing official CLI login. Install it using Anthropic's instructions at https://code.claude.com/docs/en/setup. In TokenPilot, open Agent connection > Sign in with Claude. This launches the official `claude auth login` flow in Terminal. TokenPilot never reads a password, exports a credential, or copies credentials from another application. If you have a nonstandard CLI location, launch with `TOKENPILOT_CLAUDE=/absolute/path/to/claude`.

## Use

1. Select a trusted local project. Git is recommended for tracked diffs. Existing uncommitted changes are preserved and shown alongside task changes.
2. Write a task and one concise acceptance criterion per line.
3. Choose Economy, Balanced, or Deep Work. Review spend, time and delayed token thresholds. Economy uses Sonnet at low effort by default; risk rules raise low effort to medium for security, data integrity, concurrency and public interfaces. You can explicitly choose another supported model.
4. Review Project rules. Detected npm test/lint/typecheck/build commands and pytest.ini are a starting point. Add all required project or CI checks the app cannot infer. Commands run with your local account permissions. Only use trusted projects and checks.
5. Run the task. The agent can search, read, edit and create project text files. Arbitrary commands require a visible approval with exact arguments and a reason. No automatic multi-agent work.
6. Review Activity, Changes, Verification and Usage. Stop terminates the agent process tree and ongoing verification. Resume is available when Claude reported a session ID. Resume begins a new run with the chosen run policy; provider reports may contain cumulative session totals, so do not add resumed task totals together.

Acceptance is agent-reported, supported by local checks. Passing tests and a claimed acceptance checklist are not a mathematical proof of arbitrary user intent. Tasks without a successful `finish` are incomplete even if Claude returns a normal final answer. Required failing or unrun checks prevent completion.

## Limits: what is actually controlled

| Resource | Behavior |
|---|---|
| Tool calls, repeat requests | Locally blocked before execution. Repeated blocked actions end the task. |
| Elapsed time | Local timer terminates the process tree; termination has a short grace period. |
| Token threshold | Best effort after complete assistant messages. In-flight work can exceed it. |
| Spend | Supported CLI `--max-budget-usd` request-boundary control, based on provider estimates. It is not an exact invoice or subscription cap. |
| Optional verification | Configurable count. Required checks and broader risk checks override optional-work limits. |
| Model / effort | Set when launching. Risk escalation creates a fresh session with a concise handoff and the remaining reported spend, time and token budget. |
| Escalation approval | The user can allow each request or enable automatic permission. The approved handoff is started with Continue with higher effort. Missing final accounting prevents automatic budget carryover. |
| Minimal edits, hypotheses, acceptance | Advisory instructions plus tool/state enforcement. Semantic correctness still needs review. |
| Subscription allowance | Not exposed by this integration. |

Completed tasks reject all additional tools. A short final-response grace period allows Claude to emit final accounting; if it does not, the process is terminated and unavailable accounting remains unavailable.

## Project configuration

Save `tokenpilot.json` through Project rules. Example:

```json
{
  "rules": "Keep changes focused. Preserve public interfaces. Run required tests.",
  "checks": [
    {"id":"unit", "command":["npm","test"], "required":true},
    {"id":"web", "command":["npm","run","test:web"], "required":false, "affects":["web/","shared/"]}
  ]
}
```

`CLAUDE.md` and `AGENTS.md` at the project root are included. Nested instructions must be discovered for affected directories. All configured required checks are selected; uncertain checks are selected conservatively. Risky paths or task descriptions select broader validation. `affects` lists prefixes, including dependencies such as shared modules. TokenPilot does not pretend to infer every language's dependency graph or arbitrary CI requirements.

Successful checks cache only with all three declarations: `"cacheable":true`, `"inputsClosed":true`, `"external":false`. Use them only for deterministic checks with no clock, network, service, database or other external state. The key fingerprints all files and modes under the project, including ignored files and installed dependencies (excluding `.git`), the executable, command arguments, runtime and full environment. Symlink or unreadable inputs disable caching. Unknown inputs never cache. Changed files invalidate prior visible verification. A cache hit is labeled **cached**, not passed. Checks that generate output in the project may naturally invalidate their own cache.

Check configuration is frozen during a run. The agent cannot edit tokenpilot.json with file tools. User-approved arbitrary commands remain powerful and should be reviewed. Built-in Claude tools and unrelated MCP servers are disabled for launched sessions; only TokenPilot's supported MCP tools are exposed.

## Data and privacy

No TokenPilot backend, telemetry or subscription service. Task records, full raw Claude streams, command/check logs, prompts and unabridged tool outputs are stored in `~/Library/Application Support/TokenPilot/tasks/`. Open logs from any task. These files can contain project source and task text. Directory/file permissions restrict access to the local user; logs are not encrypted. Authentication storage remains owned by the official CLI and its supported keychain/configuration mechanisms.

Claude requests leave the computer and use your configured provider account. TokenPilot does not change the provider's own telemetry preferences. It controls its own sessions, not unrelated Claude/Codex/Gemini windows. The app is not an operating-system sandbox: approved commands and trusted verification scripts run as your user.

## Development

Requires Node.js 22+ and npm on macOS. Runtime packages are pinned by package-lock.json.

```sh
npm ci
npm start
npm test
npm run test:ui
npm run dist
```

Electron packages the desktop runtime. The packaged MCP bridge runs with Electron's Node mode and does not require a separate Node installation for the bridge. Your own project's verification commands still need their respective language runtimes.

- `src/engine.cjs`: framework-independent orchestration, persistence, budgets, bounded tools and acceptance gate.
- `src/policy.cjs`, `files.cjs`, `verify.cjs`: deterministic control, filesystem boundary and conservative verification.
- `src/claude.cjs`: supported CLI streaming adapter. Capability metadata explicitly marks Codex and Gemini unavailable.
- `src/bridge.mjs`: official MCP SDK transport for the bounded local tools.
- `src/main.cjs`, `preload.cjs`, `ui/`: Electron and a CSP-restricted interface, context isolation enabled, no renderer Node access.
- `test/`: budget, accounting, cache invalidation, loop, process termination, adapter, UI and packaged-app checks.
- `benchmark/`: real paid-provider experiments and independent acceptance assertions. See BENCHMARK.md.

## Official integration references

Reviewed September 28, 2026:

- https://code.claude.com/docs/en/headless: CLI sessions, stream-json, result events, SIGTERM and resume behavior.
- https://code.claude.com/docs/en/cli-reference: tools, system-prompt, effort, spend, permissions and MCP configuration flags.
- https://code.claude.com/docs/en/mcp: local stdio servers and configuration.
- https://code.claude.com/docs/en/costs: provider cost estimates and prompt-caching considerations.

Cost shown by TokenPilot is the CLI's reported API-price estimate; it does not calculate a separate undocumented price table or equate that estimate to subscription usage. Input, cache creation, cache reads and output are separate provider categories. Reasoning is shown only when reported and treated as a subset of output, never added twice.
