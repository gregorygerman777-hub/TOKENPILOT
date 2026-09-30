const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  Security,
  normalize,
  group,
  compare,
  scopedGate,
  redact,
  snapshot,
} = require("../src/security.cjs");
const { report } = require("../src/report.cjs");
const temp = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "tokenpilot-security-"));
function record(findings = []) {
  return {
    id: "test",
    started: Date.now(),
    root: "/project",
    status: "completed",
    findings,
    groups: group(findings),
    snapshot: { excluded: [], hash: "a" },
    rulesHash: "rules",
    scanners: [
      { tool: "semgrep", version: "1", status: "completed" },
      { tool: "gitleaks", version: "1", status: "completed" },
    ],
  };
}
const finding = {
  id: "a",
  tool: "semgrep",
  rule: "eval",
  file: "a.js",
  line: 1,
  message: "Review eval",
};
test("findings group by rule and file without claiming root cause", () => {
  assert.equal(group([finding, { ...finding, line: 8 }]).length, 1);
  assert.equal(group([finding, { ...finding, file: "b.js" }]).length, 2);
});
test("missing scanners and changed rule versions cannot pass comparison", () => {
  const before = record([finding]),
    after = record();
  after.scanners[1].status = "unavailable";
  assert.equal(compare(before, after).status, "incomplete");
  after.scanners[1].status = "completed";
  after.rulesHash = "different";
  assert.equal(compare(before, after).status, "incomplete");
});
test("line shifts do not turn remaining findings into new fixes", () => {
  const before = record([finding]),
    after = record([{ ...finding, line: 40 }]);
  assert.equal(compare(before, after).status, "rejected");
});
test("selected group can clear while unrelated baseline findings remain, new findings still block", () => {
  const unrelated = { ...finding, file: "other.js" },
    before = record([finding, unrelated]),
    after = record([unrelated]);
  after.comparison = compare(before, after);
  assert.equal(
    scopedGate(before, after, [before.groups[0].id]),
    "scanner-cleared",
  );
  after.findings.push({ ...finding, file: "new.js" });
  after.groups = group(after.findings);
  after.comparison = compare(before, after);
  assert.equal(scopedGate(before, after, [before.groups[0].id]), "rejected");
});
test("behavioral verification requires a configured probe and evidence", () => {
  const before = record([finding]),
    after = record();
  before.proofConfig = { script: "assert" };
  after.comparison = compare(before, after);
  assert.equal(scopedGate(before, after, []), "incomplete");
  after.proof = { status: "verified" };
  assert.equal(scopedGate(before, after, []), "verified");
});
test("normalization excludes source and secrets from scanner reports", () => {
  const token = "ghp_" + "A".repeat(36);
  const data = [
    {
      RuleID: "secret",
      File: "a.js",
      StartLine: 3,
      Secret: token,
      Match: token,
      Description: "Secret found",
    },
  ];
  assert.ok(
    !JSON.stringify(normalize("gitleaks", data, "/tmp")).includes(token),
  );
  assert.ok(!redact('token="' + token + '"').includes(token));
});
test("HTML reports escape injected markup and contain no scripts or external assets", () => {
  const r = record([{ ...finding, message: "<script>alert(1)</script>" }]);
  const html = report(r);
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("Not implemented"));
});
test("snapshot preserves source identity and excludes scanner suppression configuration", () => {
  const root = temp(),
    dest = temp();
  fs.writeFileSync(path.join(root, "a.py"), "print(1)");
  fs.writeFileSync(path.join(root, ".semgrepignore"), "*");
  const snap = snapshot(root, dest);
  assert.equal(snap.manifest.length, 1);
  assert.equal(snap.excluded.length, 1);
  assert.ok(!fs.existsSync(path.join(dest, ".semgrepignore")));
});
test("real Semgrep and Gitleaks detect, group, then compare a focused repair", async (t) => {
  const root = temp(),
    dir = temp(),
    s = new Security(dir);
  if (
    !s.capabilities().semgrep.available ||
    !s.capabilities().gitleaks.available
  ) {
    t.skip("Install Semgrep and Gitleaks to run the live scanner test");
    return;
  }
  fs.writeFileSync(
    path.join(root, "app.py"),
    "import subprocess\ndef run(x):\n    return subprocess.run(x, shell=True)\n",
  );
  const before = await s.scan(root);
  assert.equal(before.status, "completed");
  assert.ok(before.findings.some((f) => f.rule === "python-shell-command"));
  fs.writeFileSync(
    path.join(root, "app.py"),
    "import subprocess\ndef run(x):\n    return subprocess.run(x, shell=False)\n",
  );
  const after = await s.scan(root, { baseline: before.id });
  assert.equal(after.status, "scanner-cleared");
  assert.equal(after.modelTokens, 0);
  assert.notEqual(before.snapshot.hash, after.snapshot.hash);
});
test("new evasion patterns block even if a selected static finding disappeared", () => {
  const before = record([finding]),
    after = record();
  after.comparison = compare(before, after);
  after.evasion = [{ file: "a.js", reason: "New test-detection pattern" }];
  assert.equal(scopedGate(before, after, []), "rejected");
});
test("changed scanner suppression configuration cannot create a clean gate", () => {
  const before = record([finding]),
    after = record();
  before.snapshot.excluded = [{ name: ".semgrepignore", hash: "a" }];
  after.snapshot.excluded = [{ name: ".semgrepignore", hash: "b" }];
  assert.equal(compare(before, after).status, "incomplete");
});
