const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  portable,
  validate,
  ciGate,
  sarif,
  bundle,
  verifyBundle,
} = require("../src/evidence.cjs");
const { group } = require("../src/security.cjs");
const finding = {
  id: "one",
  tool: "semgrep",
  rule: "javascript-eval",
  file: "a file.js",
  line: 2,
  severity: "ERROR",
  message: "Review eval",
};
function record(findings = []) {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    started: 1,
    status: "completed",
    root: "/private/repo",
    rulesHash: "rules",
    snapshot: {
      hash: "source",
      manifest: [{ path: "a file.js", hash: "hash" }],
      excluded: [],
    },
    scanners: [
      {
        tool: "semgrep",
        version: "1",
        status: "completed",
        command: ["secret"],
      },
      { tool: "gitleaks", version: "1", status: "completed" },
    ],
    findings,
    groups: group(findings),
    proofConfig: { script: "private-script" },
  };
}
test("CI baseline allows existing debt, blocks count increases, and treats line shifts as existing", () => {
  const baseline = portable(record([finding]));
  assert.equal(
    ciGate(record([{ ...finding, line: 99 }]), baseline).exitCode,
    0,
  );
  assert.equal(
    ciGate(record([finding, { ...finding, id: "two", line: 7 }]), baseline)
      .exitCode,
    1,
  );
  assert.equal(
    ciGate(record([{ ...finding, file: "new.js" }]), baseline).status,
    "regression",
  );
  assert.equal(ciGate(record([finding])).exitCode, 1);
  assert.equal(ciGate(record()).exitCode, 0);
});
test("CI fails closed for missing scanners, changed rule versions and invalid baselines", () => {
  const baseline = portable(record([finding]));
  const current = record();
  current.scanners = [];
  assert.equal(ciGate(current, baseline).exitCode, 2);
  const changed = record();
  changed.rulesHash = "new";
  assert.equal(ciGate(changed, baseline).exitCode, 2);
  assert.throws(() => validate({ ...baseline, scanners: [] }), /complete/);
  assert.throws(
    () =>
      validate({ ...baseline, findings: [{ ...finding, file: "../secret" }] }),
    /Invalid finding/,
  );
});
test("portable evidence omits root, commands, probe scripts and raw secret fields", () => {
  const source = record([{ ...finding, Secret: "NEVER-EXPORT" }]);
  const text = JSON.stringify(portable(source));
  for (const secret of [
    "/private/repo",
    "private-script",
    "NEVER-EXPORT",
    "command",
  ])
    assert.ok(!text.includes(secret));
});
test("SARIF uses relative encoded locations and marks scanner failure", () => {
  const source = record([finding]);
  const data = sarif(source, ciGate(source));
  assert.equal(data.version, "2.1.0");
  assert.equal(
    data.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri,
    "a%20file.js",
  );
  assert.equal(data.runs[0].results[0].baselineState, "new");
  source.scanners[0].status = "partial";
  assert.equal(sarif(source).runs[0].invocations[0].executionSuccessful, false);
});
test("bundle integrity detects edits, additions, omissions and symlinks", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-bundle-"));
  const output = path.join(base, "bundle");
  bundle(record([finding]), output);
  assert.equal(verifyBundle(output).status, "intact");
  const html = path.join(output, "report.html"),
    original = fs.readFileSync(html);
  fs.appendFileSync(html, "changed");
  assert.throws(() => verifyBundle(output), /Integrity/);
  fs.writeFileSync(html, original);
  fs.writeFileSync(path.join(output, "extra"), "x");
  assert.throws(() => verifyBundle(output), /unexpected/);
  fs.unlinkSync(path.join(output, "extra"));
  fs.unlinkSync(html);
  fs.symlinkSync(path.join(output, "summary.md"), html);
  assert.throws(() => verifyBundle(output), /regular files/);
  fs.rmSync(base, { recursive: true, force: true });
});
