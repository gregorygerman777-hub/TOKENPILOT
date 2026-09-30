const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { diagnose } = require("../src/diagnose.cjs");
const { Security, group, redact } = require("../src/security.cjs");
const { hash } = require("../src/policy.cjs");
const temp = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "tokenpilot-diagnose-"));
function project(files) {
  const root = temp();
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  const manifest = Object.entries(files).map(([f, text]) => ({
    path: f,
    hash: hash(Buffer.from(text)),
    bytes: text.length,
  }));
  return { root, manifest };
}
const one = (tool, rule, file, line, message = "Review") =>
  group([{ id: "x", tool, rule, file, line, message }])[0];

test("python brief isolates the enclosing method, references, tests and checks", () => {
  const { root, manifest } = project({
    "tools/preview.py":
      "import subprocess\n\nclass Preview:\n    def __init__(self):\n        self.n = 0\n\n    def run(self, path):\n        cmd = f'wc -l {path}'\n        return subprocess.run(cmd, shell=True)\n\n    def other(self):\n        return 1\n",
    "app.py": "from tools.preview import Preview\nPreview().run('a.txt')\n",
    "tests/test_preview.py": "from tools.preview import Preview\n",
    "tokenpilot.json": JSON.stringify({
      checks: [{ id: "unit", command: ["python3", "-m", "pytest"] }],
    }),
  });
  const b = diagnose({
    tree: root,
    manifest,
    group: one("semgrep", "python-shell-command", "tools/preview.py", 9),
    root,
  });
  assert.deepEqual(
    b.blocks.map((x) => [x.start, x.end, x.symbol]),
    [[7, 9, "run"]],
  );
  assert.ok(b.blocks[0].text.startsWith("7:     def run(self, path):"));
  assert.ok(!b.blocks[0].text.includes("def other"));
  assert.deepEqual(
    b.callers.map((c) => `${c.file}:${c.line}`),
    ["app.py:2"],
  );
  assert.deepEqual(b.tests, ["tests/test_preview.py"]);
  assert.deepEqual(b.checks, [
    { id: "unit", command: ["python3", "-m", "pytest"] },
  ]);
  assert.equal(b.modelTokens, 0);
  assert.equal(b.changedSinceScan, false);
  assert.match(b.text, /Fix direction: Pass the command as an argument list/);
  assert.match(b.text, /protected during security repair: tests\/test_preview\.py/);
});

test("javascript brief follows braces and excludes the function's own lines from references", () => {
  const { root, manifest } = project({
    "src/config.js":
      "const fs = require('fs');\nfunction loadConfig(text) {\n  if (!text) {\n    return {};\n  }\n  return eval('(' + text + ')');\n}\nfunction unrelated() {\n  return loadConfig('{}');\n}\nmodule.exports = { loadConfig };\n",
    "src/server.js":
      "const { loadConfig } = require('./config');\nconst c = loadConfig(process.env.CONFIG);\n",
    "test/config.test.js": "require('../src/config');\n",
    "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
  });
  const b = diagnose({
    tree: root,
    manifest,
    group: one("semgrep", "javascript-eval", "src/config.js", 6),
    root,
  });
  assert.deepEqual(
    b.blocks.map((x) => [x.start, x.end, x.symbol]),
    [[2, 7, "loadConfig"]],
  );
  assert.deepEqual(
    b.callers.map((c) => `${c.file}:${c.line}`),
    ["src/config.js:9", "src/config.js:11", "src/server.js:1", "src/server.js:2"],
  );
  assert.deepEqual(b.tests, ["test/config.test.js"]);
  assert.deepEqual(b.checks, [{ id: "test", command: ["npm", "run", "test"] }]);
  assert.match(b.text, /Code, src\/config\.js lines 2-7, function loadConfig/);
});

test("oversized functions fall back to a bounded window around the finding", () => {
  const body = Array.from({ length: 90 }, (_, i) => `  const v${i} = ${i};`);
  body[70] = "  return eval(input);";
  const { root, manifest } = project({
    "big.js": `function huge(input) {\n${body.join("\n")}\n}\n`,
  });
  const b = diagnose({
    tree: root,
    manifest,
    group: one("semgrep", "javascript-eval", "big.js", 72),
    root,
  });
  assert.equal(b.blocks[0].window, true);
  assert.equal(b.blocks[0].symbol, "huge");
  assert.equal(b.blocks[0].end - b.blocks[0].start, 16);
  assert.match(b.text, /inside huge/);
});

test("secret findings withhold source and never echo the value", () => {
  const token = "ghp_" + "B".repeat(36);
  const { root, manifest } = project({
    "settings.py": `DEBUG = True\nGITHUB_TOKEN = "${token}"\n`,
  });
  const b = diagnose({
    tree: root,
    manifest,
    group: one("gitleaks", "github-pat", "settings.py", 2),
    root,
    redact,
  });
  assert.equal(b.blocks[0].text, null);
  assert.ok(!JSON.stringify(b).includes(token));
  assert.match(b.text, /Secret location: settings\.py line 2\. The value is withheld/);
  assert.match(b.text, /rotated/);
});

test("excerpts are redacted and changed source is flagged", () => {
  const key = "sk-" + "C".repeat(24);
  const { root, manifest } = project({
    "a.js": `exports.run = x => eval(x + "${key}");\n`,
  });
  const g = one("semgrep", "javascript-eval", "a.js", 1);
  assert.ok(
    !diagnose({ tree: root, manifest, group: g, root, redact }).text.includes(key),
  );
  fs.appendFileSync(path.join(root, "a.js"), "// edited\n");
  const b = diagnose({ tree: root, manifest, group: g, root });
  assert.equal(b.changedSinceScan, true);
  assert.match(b.text, /changed after this scan/);
});

test("Security.brief builds from the real scan snapshot", async (t) => {
  const dir = temp(),
    s = new Security(dir);
  if (!s.capabilities().semgrep.available || !s.capabilities().gitleaks.available) {
    t.skip("Install Semgrep and Gitleaks to run the live brief test");
    return;
  }
  const { root } = project({
    "lib/calc.js":
      "function calculate(expression) {\n  return eval(expression);\n}\nmodule.exports = { calculate };\n",
    "index.js": "const { calculate } = require('./lib/calc');\nconsole.log(calculate('1+1'));\n",
  });
  const r = await s.scan(root);
  assert.equal(r.status, "completed");
  const g = r.groups.find((g) => g.rule === "javascript-eval");
  const b = s.brief(r.id, g.id);
  assert.equal(b.file, "lib/calc.js");
  assert.deepEqual(b.lines, [2]);
  assert.deepEqual([b.blocks[0].start, b.blocks[0].end], [1, 3]);
  assert.deepEqual(
    b.callers.map((c) => `${c.file}:${c.line}`),
    ["index.js:1", "index.js:2", "lib/calc.js:4"],
  );
  assert.throws(() => s.brief(r.id, "missing"), /Unknown finding group/);
  const saved = fs.readFileSync(path.join(dir, r.id + ".json"), "utf8");
  assert.ok(!saved.includes("return eval(expression)"));
});
