# CI without AI calls

TokenPilot's CI gate detects new scanner findings. It is separate from the stricter repair gate: existing baseline findings can remain in CI, but a selected repair cannot complete while its selected group remains.

Prerequisites: Node 22+, Semgrep and Gitleaks installed on the runner. Pin scanner versions. Missing tools, parse errors, version/rule mismatches and changed exclusion manifests exit 2, never pass.

From a TokenPilot source checkout:

```sh
node src/cli.cjs ci /absolute/project --output /tmp/pilot-first-run
```

Exit 0: no findings. Exit 1: findings. Exit 2: incomplete scan or error. Even on exit 1, the evidence directory contains `evidence.json`, `report.html`, `findings.sarif`, `summary.md` and a SHA-256 manifest.

Review the findings and retain `evidence.json` outside the scanned source as your baseline. Then:

```sh
node src/cli.cjs ci /absolute/project --baseline /path/to/reviewed-evidence.json --output /tmp/pilot-next-run
node src/cli.cjs verify-bundle /tmp/pilot-next-run
```

Baseline mode exits 1 for new rule/file groups or count increases. Line shifts alone do not create new findings. This is count-based matching, so a replaced finding in the same rule/file group can be indistinguishable. Renames are conservatively new groups. Review baseline changes like code changes: a modified baseline can conceal regressions. Checksums establish file integrity against the supplied manifest, not author authenticity or scan correctness.

## GitHub Actions

`action.yml` is a composite action ready for a repository you publish. It does not install tools or require an AI credential. Check out TokenPilot into a sibling directory outside the repository being scanned, install pinned Semgrep/Gitleaks, then use the local action path:

```yaml
- uses: ./tokenpilot
  with:
    project: ${{ github.workspace }}/project
    output: ${{ runner.temp }}/tokenpilot-evidence
- name: Keep evidence even when the gate fails
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: tokenpilot-evidence
    path: ${{ runner.temp }}/tokenpilot-evidence
```

You must supply the checkout steps for your published repository. There is no claimed public TokenPilot GitHub URL yet. SARIF is compatible with consumers of SARIF 2.1.0, including GitHub code scanning where enabled; no remote upload has been tested or performed here.
