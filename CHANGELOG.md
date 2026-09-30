# Changelog

## Unreleased

- Diagnose stage: deterministic repair briefs per finding group (enclosing function, references, related tests, checks, fix direction), 0 model tokens. Secrets are withheld from briefs.
- Desktop focused repair and the new `tokenpilot_brief` MCP tool hand Claude the brief instead of a one-sentence task.
- `tokenpilot repair`: scan, brief, budgeted repair, gate and revert on a private clone, with a self-contained trust report and a verified-only patch.
- README restructured around the pipeline with fresh app screenshots; full reference moved to `docs/GUIDE.md`.
- Scanner availability probe waits up to 20 seconds, so parallel test runs no longer skip live scanner tests.
- `benchmark/brief.cjs`: paired study of brief versus one-sentence repair handoffs. Not yet run; no savings figure claimed.

## 1.2.0

- Claude Code plugin with scan/verify skills and six MCP tools; uses the shared local scan history.
- Real file/folder selection in the browser, bounded local uploads, and single-file path scanning.

- Real local browser workbench with a same-origin authenticated API, persisted scans, progress, stop, source comparison, HTML reports and SARIF/JSON downloads.
- Desktop button opens the browser workbench with the same scan store and engine.
- Baseline-aware CI gate with explicit exit codes and conservative version/coverage matching.
- Portable evidence bundles omit source trees, raw logs, absolute roots and frozen probe scripts; checksum verification detects changed bundle files.
- Built-in before/after CLI demo uses real scanners and a documented fixed repair recipe. No AI calls or claim of behavioral proof.
- Composite GitHub Action and contribution-ready documentation. No repository publication or star count claimed.

## 1.1.0

Local Security Lab, static candidate grouping, scoped repair gate, reports and sample project.

## 1.0.0

Budgeted Claude coding controller, bounded tools, loop detection, conservative verification cache and local usage accounting.
