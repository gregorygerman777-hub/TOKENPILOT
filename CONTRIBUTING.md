# Contributing

Start with `npm ci` and `npm test`. For the real scanner integration, install Semgrep and Gitleaks. Use `npm run test:ui` and `node test/security-ui.cjs` on a desktop session for interface changes.

Useful contributions: small reproducible false-positive fixtures, scanner adapter coverage, clearer evidence states, and measurements on real tasks. Include the smallest fixture and the exact expected gate outcome. Never commit a real secret, private repository, access token or provider credential.

Preserve these invariants:

- Missing accounting stays missing. A cached or skipped check is not an executed pass.
- Static clearance is not behavioral verification.
- Do not relax checks to inflate savings or verified counts.
- No model call for discovery, grouping, report formatting or local accounting.
- Do not add default polling, telemetry, a hosted service, or automatic model delegation.

Keep PRs focused. Explain the behavior change, the reproducer and the checks you ran. Reviewers should be able to reproduce the evidence locally.
