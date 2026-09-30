const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Security } = require("../src/security.cjs");
const { repairAll, reason } = require("../src/pipeline.cjs");
const temp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

function repo() {
  const root = temp("tokenpilot-pipe-src-");
  const files = {
    "lib/config.js":
      "function parseConfig(text) {\n  return eval('(' + text + ')');\n}\nmodule.exports = { parseConfig };\n",
    "tools/run.py":
      "import subprocess\n\n\ndef run(cmd):\n    return subprocess.run(cmd, shell=True)\n",
  };
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  const git = (args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git(["init", "-q"]);
  git(["add", "."]);
  git(["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-qm", "init"]);
  return root;
}

// Stands in for Claude: fixes the eval group, makes the shell group worse.
async function fakeRepairer({ root, group, validate }) {
  if (group.rule === "javascript-eval")
    fs.writeFileSync(
      path.join(root, "lib/config.js"),
      "function parseConfig(text) {\n  return JSON.parse(text);\n}\nmodule.exports = { parseConfig };\n",
    );
  else fs.appendFileSync(path.join(root, "tools/run.py"), "\n\ndef calc(x):\n    return eval(x)\n");
  const evidence = await validate({ root });
  const ok = evidence.gateStatus === "scanner-cleared";
  return {
    id: "fake-" + group.rule,
    status: ok ? "completed" : "failed",
    checks: [{ id: "unit", status: "passed", required: true }],
    usage: { input_tokens: 1000, output_tokens: 200 },
    reportedCost: 0.01,
    metrics: { toolCalls: 4 },
    result: ok ? "Replaced eval with JSON.parse." : null,
  };
}

test("repair pipeline keeps verified fixes, reverts rejected ones and never touches the source repo", async (t) => {
  const security = new Security(temp("tokenpilot-pipe-audits-"));
  if (!security.capabilities().semgrep.available || !security.capabilities().gitleaks.available) {
    t.skip("Install Semgrep and Gitleaks to run the live pipeline test");
    return;
  }
  const source = repo();
  const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" });
  const output = path.join(temp("tokenpilot-pipe-out-"), "report");
  const run = await repairAll(source, { security, output, repairer: fakeRepairer });

  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }), before);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: source, encoding: "utf8" }), "");
  assert.equal(run.attempted, 2);
  const byRule = Object.fromEntries(run.repairs.map((r) => [r.group.rule, r]));
  assert.equal(byRule["javascript-eval"].outcome, "verified");
  assert.equal(byRule["javascript-eval"].tokens, 1200);
  assert.equal(byRule["javascript-eval"].brief.symbol, "parseConfig");
  assert.equal(byRule["python-shell-command"].outcome, "rejected");
  assert.match(byRule["python-shell-command"].reason, /still reported|new finding/);
  assert.match(byRule["python-shell-command"].diff, /eval\(x\)/);

  const patch = fs.readFileSync(path.join(output, "fixes.patch"), "utf8");
  assert.match(patch, /\+  return JSON\.parse\(text\);/);
  assert.ok(!patch.includes("eval(x)"), "rejected attempt must not reach the patch");
  const html = fs.readFileSync(path.join(output, "report.html"), "utf8");
  assert.ok(!/<script/i.test(html));
  assert.match(html, /Verified patches · 1/);
  assert.match(html, /Stopped by the gate · 1/);
  assert.match(html, /50%<\/strong><span>of patches verified/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(output, "run.json"))).repairs.length === 2);
  await assert.rejects(repairAll(source, { security, output, repairer: fakeRepairer }), /already exists/);
  fs.writeFileSync(path.join(source, "dirty.txt"), "x");
  await assert.rejects(
    repairAll(source, { security, output: output + "-2", repairer: fakeRepairer }),
    /Commit or stash/,
  );
});

test("rejection reasons name the gate or check that failed", () => {
  assert.match(
    reason({ status: "failed" }, { gateStatus: "rejected", comparison: { introduced: [{}], remaining: [] } }),
    /1 new finding introduced/,
  );
  assert.match(
    reason({ status: "failed", checks: [{ id: "unit", status: "failed" }] }, null),
    /Required checks failing: unit/,
  );
  assert.match(reason({ status: "budget_exhausted", checks: [] }, null), /Budget|limit/);
  assert.equal(reason({ status: "completed" }, null), null);
});
