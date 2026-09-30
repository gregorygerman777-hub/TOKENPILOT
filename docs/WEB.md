# Local browser workbench

From the project directory:

```sh
npm run web
```

Open the exact URL printed in Terminal (normally `http://127.0.0.1:8792`). Keep that Terminal running. Use Ctrl+C to stop. To choose another port: `node src/cli.cjs serve 9000`.

The desktop app also has **Security Lab → Open browser workbench**, so Terminal is optional. That server shares the desktop scan store and stops with the desktop app. The CLI defaults to the same scan store on macOS; `TOKENPILOT_DATA` and `TOKENPILOT_AUDITS` allow isolated storage.

The browser is a real client of the local backend: scans, progress, history, source comparisons and HTML/SARIF/JSON downloads come from the shared Security engine. Static findings are grouped by rule/file. Agent repairs still run from the desktop app. A public marketing website cannot scan folders on a visitor's computer; the local server must be running.

The server binds only to 127.0.0.1. API operations require a random session bearer token, exact Host matching and same-origin browser requests. There is no permissive CORS, external script or remote scanner API. These controls reduce cross-site access; they do not protect against malicious software already running as your local user. Do not reverse-proxy the server onto the internet.

The interface reads scan state at one-second intervals during a run and five seconds while idle. This does not call a model. Snapshots and findings persist on disk across browser reloads. Missing tools and parse errors remain visible as incomplete scans.

Scanner dependencies:

```sh
brew install semgrep gitleaks
```

Use **Use sample project** to create a separate intentional sample and scan it. To scan your own source, paste an absolute folder path. **Compare current folder** compares the current source against the selected historical scan. Configuration for optional Docker probes remains in the project `tokenpilot.json`; Docker is not installed automatically.

## Selecting actual files

Use **Choose files** for individual source files, or **Choose folder** for a source folder. The browser sends file bytes only to the local server, which writes a private copy and scans that copy. Limits: 256 files, 4 MB each, 16 MB total. For larger projects, paste the absolute folder path instead. Direct path scanning also accepts a single file. Uploaded copies do not update when originals change; select them again for a new scan. Use direct paths for repeated before/after comparisons.

The displayed savings state is **not measured** unless a matched baseline exists. Zero model tokens for deterministic scans is consumption, not measured avoided tokens.
