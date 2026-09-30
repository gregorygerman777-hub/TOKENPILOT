---
name: verify
description: Compare a local repair against a captured TokenPilot scan, preserving the baseline and reporting unresolved evidence.
disable-model-invocation: true
argument-hint: <baseline-run-id> <absolute-file-or-folder>
---
Use the baseline run ID and absolute target in $ARGUMENTS. If missing, use tokenpilot_history for the user's target and identify the intended pre-repair scan; do not invent a baseline or substitute a newer one just to pass.

Call tokenpilot_scan with that path and baselineId, then inspect tokenpilot_results when ready. Report introduced and remaining findings, scanner completeness and gate state. Never mark incomplete or failed scans as clean. Do not alter scanner rules, suppressions, tests or baseline evidence to obtain a pass.

If a change was requested, run the project's relevant required verification through Claude Code's normal tools and report those results separately. TokenPilot's static gate does not replace project tests or an independent behavioral challenge. Export evidence with tokenpilot_export only when the user wants an export, using a new directory outside scanned source.
