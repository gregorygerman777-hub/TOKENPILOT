# TokenPilot inside Claude Code

This checkout is a Claude Code plugin. It includes two slash-command skills and a local MCP server backed by the same Security engine and scan store as the web and desktop apps.

From the extracted TokenPilot folder, install dependencies once:

```sh
npm ci
```

Then launch Claude Code with the plugin, using the absolute checkout path:

```sh
claude --plugin-dir /absolute/path/to/TokenPilot
```

Inside Claude:

```text
/tokenpilot:scan /absolute/path/to/my-project
/tokenpilot:scan /absolute/path/to/file.py
/tokenpilot:verify BASELINE_RUN_ID /absolute/path/to/my-project
```

Or ask: “Use TokenPilot to scan this project. Explain the findings before changing anything.” The seven tools are doctor, scan, results, brief, history, stop and export. `brief` returns a locally built repair brief for one finding group, so Claude can start a fix from the relevant code instead of exploring the repository. Scans run asynchronously and persist real scanner results; the browser dashboard can display them from the shared store. No hook scans on every edit, no background model calls, no automatic file edits.

Scanners must be installed (`brew install semgrep gitleaks` on this Mac), and Node must be available to Claude Code. Run `/mcp` in Claude if the tool server is not connected. The plugin does not enforce TokenPilot desktop budgets on the surrounding Claude session. Tool schemas, findings and Claude reasoning still consume Claude tokens; no plugin-specific savings percentage has been measured.

The local-plugin loading flag is documented by Anthropic: https://code.claude.com/docs/en/plugins . Plugin structure and MCP configuration: https://code.claude.com/docs/en/plugins-reference . No claim of official Anthropic endorsement or marketplace publication.
