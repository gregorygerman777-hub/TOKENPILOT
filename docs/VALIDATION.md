# Validation record

## Version 1.2.1

- 41 automated tests passed, including real scanner and MCP integration tests.
- Live browser flow passed sample scanning, findings, persisted history, exports, upload and error handling at four widths.
- Installer integration passed checksum rejection before installation, actual app copy, paths with spaces, bundled CLI scanner detection, backup on reinstall and collision protection. Testing used an isolated prefix and did not alter the user shell profile.
- Packaged Security Lab flow passed, including the local browser bridge. All source/backend, desktop UI, web UI and demo files match the packaged archive byte for byte.
- No new paid-model savings benchmark or Docker execution was run. Previous benchmark limitations still apply.


## Version 1.2

- 33 automated core, security, CI/export, HTTP and MCP integration tests passed. Real Semgrep and Gitleaks runs were included, with no skips on this Mac.
- Browser end-to-end checks passed: actual selected-file upload and scan, sample folder scanning, progress, persisted history, reload restoration, SARIF download, unchanged baseline rejection, missing-path errors, and layouts at 375/768/1024/1440.
- The MCP client connected over stdio, discovered all six tools, scanned one actual source file, received the finding, exported evidence, and read shared history. `claude plugin validate .` passed. A paid Claude conversation using the plugin was not run.
- The predetermined before/after demo detected one eval finding and then cleared it after the documented JSON-only repair. This is static clearance, not behavioral verification or an autonomous AI repair.
- Live CI regression returned exit 1 and produced a checksum-valid evidence bundle. Automated tests cover existing baseline debt, count increases, line shifts, incomplete scanners, changed rules and invalid baseline records.
- The final packaged desktop app opened its included HTTP workbench, enforced API authorization, and passed its Security Lab workflow with both installed scanners.
- The application remains unsigned and not notarized. Docker execution is unvalidated. No new token-savings percentage is claimed.

## Version 1.1

- All 25 core, integration and security tests passed on this Mac. Live scanner checks used Semgrep 1.176.0 and Gitleaks 8.30.1, including a before/after repair comparison.
- Source UI checks passed at widths 375, 768, 1024 and 1440. The final packaged app passed the Security Lab workflow: sample scan, two grouped findings, zero model tokens for scanning, focused repair handoff, gate removal, offline report export, rejection of an unchanged rescan, visible scan history and no horizontal overflow at all four widths.
- All 21 production source, UI, font, rule and demo files match the final app.asar byte-for-byte. The builder-normalized package manifest reports version 1.1.0. See package-integrity.json.
- The Apple Silicon DMG passed hdiutil checksum verification. It is unsigned and not notarized.
- Docker was unavailable. Live container execution has not been validated; the optional probe adapter must not be treated as demonstrated exploit verification. No independent AI Challenger is implemented.
- No new paid Claude repair or token benchmark was run for 1.1. The prior live integration and token measurements below describe 1.0.

## Version 1.0 (historical)

Tested on macOS 26.6.2, arm64, Node 24.21.0, Electron 44.4.5 and Claude Code 2.1.283.

- 14 focused core/integration tests passed: bounded budgets, risk classification, repeats and changed inputs, call cap, token category accounting, deterministic output evidence, source/dependency/config/argument/environment cache invalidation, conservative selection, cached vs passed status, failed-check behavior, stopping subprocesses, path traversal/symlinks, CLI arguments/stream parsing, delayed token-stop enforcement and acceptance state.
- Source and final packaged UI checks passed: mode changes, task validation, navigation, history, advanced controls, approval cancellation, four widths (375, 768, 1024, 1440), zero horizontal overflow, 8px/4px spacing and minimum control target height.
- Visual inspection used the rendered desktop screenshot. Muted text contrast is 5.41:1 against the paper background; primary button contrast is 6.90:1. No external fonts, images, tracking or UI network requests.
- Real packaged integration passed: detected existing official login; connected bundled MCP bridge; edited a fixture file; started required verification; stopped the running process; resumed the reported session; passed verification; displayed Git diffs and provider usage with cumulative-session caveat. See packaged-validation.json.
- The first packaged resume test encountered an extended interruption and provider retry problems. It is not counted as a pass. The subsequent end-to-end test passed. Sleep handling now explicitly stops the active task for later resume.
- All 11 production source/UI files were compared byte-for-byte with the final app.asar and matched. The current package-integrity.json supersedes that record.
- The final DMG passed hdiutil checksum verification. The build deliberately skips Developer ID signing and has not been notarized.
- Benchmark evidence and failure accounting are in ../BENCHMARK.md. No universal savings percentage or exact token cap is asserted.

The app has not been tested across every repository language, Claude account type, macOS version or external check dependency. Arbitrary project acceptance still requires the user's review.
