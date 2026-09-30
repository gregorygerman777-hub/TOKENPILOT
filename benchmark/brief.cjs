// Paired study: the same scanner finding repaired from the one-sentence handoff
// versus the locally built repair brief. Everything else is held equal.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync, spawnSync } = require("node:child_process");
const { Engine } = require("../src/engine.cjs");
const { Security, scopedGate } = require("../src/security.cjs");
const { usageTokens } = require("../src/policy.cjs");

const PY_PATH = "import os, sys\nsys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))\n";
const cases = [
  {
    id: "js-config-eval",
    rule: "javascript-eval",
    files: {
      "README.md": "# Settings service\n\nServes configuration for internal dashboards. Config files are JSON.\n",
      "package.json": JSON.stringify({ name: "settings", private: true }, null, 2) + "\n",
      "src/config.js":
        'const fs = require("node:fs");\nconst path = require("node:path");\n\nconst DEFAULTS = { port: 8080, host: "127.0.0.1", debug: false };\n\nfunction readConfigFile(file) {\n  return fs.readFileSync(path.resolve(file), "utf8");\n}\n\nfunction parseConfig(text) {\n  if (!text || !text.trim()) return { ...DEFAULTS };\n  const parsed = eval("(" + text + ")");\n  return { ...DEFAULTS, ...parsed };\n}\n\nfunction loadConfig(file) {\n  return parseConfig(readConfigFile(file));\n}\n\nmodule.exports = { DEFAULTS, parseConfig, loadConfig };\n',
      "src/server.js":
        'const http = require("node:http");\nconst { loadConfig } = require("./config");\nconst { route } = require("./routes");\nconst log = require("./log");\n\nfunction start(file) {\n  const config = loadConfig(file);\n  const server = http.createServer((req, res) => route(req, res, config));\n  server.listen(config.port, config.host, () => log.info("listening", config.port));\n  return server;\n}\n\nmodule.exports = { start };\n',
      "src/routes.js":
        'function route(req, res, config) {\n  if (req.url === "/health") {\n    res.end("ok");\n    return;\n  }\n  res.setHeader("content-type", "application/json");\n  res.end(JSON.stringify({ debug: config.debug }));\n}\n\nmodule.exports = { route };\n',
      "src/log.js":
        'function info(...parts) {\n  if (process.env.QUIET) return;\n  console.log(new Date().toISOString(), ...parts);\n}\n\nmodule.exports = { info };\n',
      "test/config.test.cjs":
        'const assert = require("node:assert/strict");\nconst { parseConfig, DEFAULTS } = require("../src/config");\nassert.deepEqual(parseConfig(""), DEFAULTS);\nassert.equal(parseConfig(\'{"port": 9000}\').port, 9000);\nassert.equal(parseConfig(\'{"debug": true}\').debug, true);\nassert.throws(() => parseConfig("process.exit(3)"));\n',
    },
    checks: [["node", "test/config.test.cjs"]],
    criteria:
      "parseConfig accepts JSON config text and merges it over DEFAULTS\nConfig text that is not JSON is rejected without being executed",
    hidden: {
      kind: "node",
      code: 'const assert = require("node:assert/strict");\nconst { parseConfig } = require(process.cwd() + "/src/config");\nassert.deepEqual(parseConfig(\'{"host": "0.0.0.0", "port": 1}\'), { port: 1, host: "0.0.0.0", debug: false });\nassert.throws(() => parseConfig("(() => { globalThis.pwned = 1; return {}; })()"));\nassert.equal(globalThis.pwned, undefined);\nassert.throws(() => parseConfig("{port: 1}"));\n',
    },
  },
  {
    id: "py-shell",
    rule: "python-shell-command",
    files: {
      "README.md": "# Line report\n\nCounts lines in files for the weekly size report.\n",
      "tools/__init__.py": "",
      "tools/linecount.py":
        'import subprocess\n\n\ndef count_lines(path):\n    result = subprocess.run(\n        f"wc -l < \'{path}\'", shell=True, capture_output=True, text=True, check=True\n    )\n    return int(result.stdout.strip())\n\n\ndef summarize(paths):\n    return {p: count_lines(p) for p in paths}\n',
      "tools/report.py":
        'from tools.linecount import summarize\n\n\ndef render(paths):\n    counts = summarize(paths)\n    width = max((len(p) for p in counts), default=0)\n    return "\\n".join(f"{p.ljust(width)}  {n}" for p, n in sorted(counts.items()))\n',
      "cli.py":
        'import sys\n\nfrom tools.report import render\n\nif __name__ == "__main__":\n    print(render(sys.argv[1:]))\n',
      "tests/test_linecount.py":
        PY_PATH +
        'import tempfile\nfrom tools.linecount import count_lines\n\nwith tempfile.TemporaryDirectory() as d:\n    plain = os.path.join(d, "a.txt")\n    with open(plain, "w") as f:\n        f.write("1\\n2\\n3\\n")\n    assert count_lines(plain) == 3\n    tricky = os.path.join(d, "b\'; touch marker; echo \'")\n    with open(tricky, "w") as f:\n        f.write("x\\ny\\n")\n    assert count_lines(tricky) == 2\n    assert not os.path.exists("marker")\nprint("ok")\n',
    },
    checks: [["python3", "tests/test_linecount.py"]],
    criteria:
      "count_lines returns the number of lines in the given file\nFile names containing shell syntax are treated as plain names and run no commands",
    hidden: {
      kind: "python",
      code: 'import os, sys, tempfile\nsys.path.insert(0, os.getcwd())\nfrom tools.linecount import count_lines\nwith tempfile.TemporaryDirectory() as d:\n    p = os.path.join(d, "c\'; touch hidden_marker; echo \'$(touch hidden_marker) d")\n    with open(p, "w") as f:\n        f.write("1\\n2\\n3\\n4\\n")\n    assert count_lines(p) == 4\n    assert not os.path.exists("hidden_marker")\n    e = os.path.join(d, "empty")\n    open(e, "w").close()\n    assert count_lines(e) == 0\n',
    },
  },
  {
    id: "py-pickle",
    rule: "python-pickle",
    files: {
      "README.md": "# Shop sessions\n\nSession tokens travel in a browser cookie.\n",
      "shop/__init__.py": "",
      "shop/session.py":
        'import base64\nimport pickle\n\n\ndef dump_session(data):\n    return base64.b64encode(pickle.dumps(data)).decode("ascii")\n\n\ndef load_session(token):\n    return pickle.loads(base64.b64decode(token))\n',
      "shop/views.py":
        'from shop.session import dump_session, load_session\n\n\ndef cart_view(cookies):\n    session = load_session(cookies["session"]) if "session" in cookies else {}\n    return {"items": session.get("cart", [])}\n\n\ndef add_item(cookies, item):\n    session = load_session(cookies["session"]) if "session" in cookies else {}\n    session.setdefault("cart", []).append(item)\n    return dump_session(session)\n',
      "shop/prices.py":
        'PRICES = {"apple": 0.5, "bread": 2.25, "milk": 1.1}\n\n\ndef total(items):\n    return round(sum(PRICES.get(i, 0) for i in items), 2)\n',
      "tests/test_session.py":
        PY_PATH +
        'import base64, builtins, pickle\nfrom shop.session import dump_session, load_session\n\ndata = {"user": "ana", "cart": ["apple", "milk"]}\nassert load_session(dump_session(data)) == data\n\nclass Evil:\n    def __reduce__(self):\n        return (exec, ("import builtins; builtins.PWNED = True",))\n\ntoken = base64.b64encode(pickle.dumps(Evil())).decode("ascii")\ntry:\n    load_session(token)\nexcept Exception:\n    pass\nassert not getattr(builtins, "PWNED", False)\nprint("ok")\n',
    },
    checks: [["python3", "tests/test_session.py"]],
    criteria:
      "dump_session and load_session round-trip session dictionaries\nA session token cannot execute code when loaded",
    hidden: {
      kind: "python",
      code: 'import os, sys, base64, builtins, pickle\nsys.path.insert(0, os.getcwd())\nfrom shop.session import dump_session, load_session\nfrom shop.views import add_item, cart_view\nc = {"session": add_item({}, "bread")}\nassert cart_view(c) == {"items": ["bread"]}\nassert load_session(dump_session({"n": 1, "xs": [1, "a", None, True]})) == {"n": 1, "xs": [1, "a", None, True]}\nclass E:\n    def __reduce__(self):\n        return (exec, ("import builtins; builtins.HIDDEN = 1",))\ntry:\n    load_session(base64.b64encode(pickle.dumps(E())).decode())\nexcept Exception:\n    pass\nassert not hasattr(builtins, "HIDDEN")\n',
    },
  },
  {
    id: "js-calc-eval",
    rule: "javascript-eval",
    files: {
      "README.md": "# Quote calculator\n\nEvaluates arithmetic typed by sales staff into the quote form.\n",
      "package.json": JSON.stringify({ name: "quote", private: true }, null, 2) + "\n",
      "lib/evaluate.js":
        'const ALLOWED = /^[\\d+\\-*/().\\s]+$/;\n\nfunction evaluate(expression) {\n  if (!ALLOWED.test(expression)) throw new Error("Unsupported characters");\n  return eval(expression);\n}\n\nmodule.exports = { evaluate };\n',
      "lib/quote.js":
        'const { evaluate } = require("./evaluate");\nconst { format } = require("./format");\n\nfunction lineTotal(line) {\n  return evaluate(line.formula) * line.quantity;\n}\n\nfunction quote(lines) {\n  return format(lines.reduce((sum, line) => sum + lineTotal(line), 0));\n}\n\nmodule.exports = { quote, lineTotal };\n',
      "lib/format.js":
        'function format(amount) {\n  return "$" + amount.toFixed(2);\n}\n\nmodule.exports = { format };\n',
      "test/evaluate.test.cjs":
        'const assert = require("node:assert/strict");\nconst { evaluate } = require("../lib/evaluate");\nassert.equal(evaluate("2 + 3 * 4"), 14);\nassert.equal(evaluate("(2 + 3) * 4"), 20);\nassert.equal(evaluate("10 / 4"), 2.5);\nassert.equal(evaluate("-3 + 5"), 2);\nassert.throws(() => evaluate("2 +"));\nassert.throws(() => evaluate("alert(1)"));\n',
    },
    checks: [["node", "test/evaluate.test.cjs"]],
    criteria:
      "evaluate computes +, -, *, / with parentheses, unary minus, decimals and normal precedence\nMalformed or non-arithmetic input throws an Error",
    hidden: {
      kind: "node",
      code: 'const assert = require("node:assert/strict");\nconst { evaluate } = require(process.cwd() + "/lib/evaluate");\nassert.equal(evaluate("1.5 * (2 - -2)"), 6);\nassert.equal(evaluate("8 - 2 - 1"), 5);\nassert.equal(evaluate("2 * (3 + (4 - 1)) / 3"), 4);\nfor (const bad of ["", "()", "1 2", "(1 + 2", "3 * / 4", "process.exit(1)"]) assert.throws(() => evaluate(bad), Error, bad);\n',
    },
  },
];

// The handoff text the desktop app produced before repair briefs existed.
const sentence = (g) =>
  `Review and fix ${g.rule} in ${g.file} at lines ${g.findings.map((f) => f.line).join(", ")}. Static evidence: ${g.findings[0].message}. Preserve intended behavior. Do not hide findings or modify scanner configuration. Report false positives honestly. The selected group must clear without introducing new findings. Required project checks must pass.`;
// The handoff text the desktop app produces now.
const withBrief = (g, brief) =>
  `Review and fix ${g.rule} in ${g.file}. Preserve intended behavior. Do not hide findings or modify scanner configuration. Report false positives honestly. The selected group must clear without introducing new findings. Required project checks must pass.\n\n${brief.text}`;

function fixture(c) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "tokenpilot-brief-")),
  );
  for (const [f, text] of Object.entries(c.files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  fs.writeFileSync(
    path.join(root, "tokenpilot.json"),
    JSON.stringify({
      rules: "Do not modify tests or verification scripts.",
      checks: c.checks.map((command, i) => ({
        id: "check" + (i + 1),
        command: command[0] === "node" ? [process.execPath, ...command.slice(1)] : command,
        required: true,
        cacheable: true,
        external: false,
        inputsClosed: true,
      })),
    }),
  );
  const g = (args) => execFileSync("git", args, { cwd: root });
  g(["init", "-q"]);
  g(["add", "."]);
  g(["-c", "user.name=TokenPilot", "-c", "user.email=benchmark@localhost", "commit", "-qm", "fixture"]);
  return root;
}
function hidden(c, root) {
  const r =
    c.hidden.kind === "node"
      ? spawnSync(process.execPath, ["-e", c.hidden.code], { cwd: root, encoding: "utf8", timeout: 20000 })
      : spawnSync("python3", ["-c", c.hidden.code], { cwd: root, encoding: "utf8", timeout: 20000 });
  return { passed: r.status === 0, output: (r.stderr || r.stdout || "").slice(-600) };
}

async function main() {
  const reps = Number(process.env.REPETITIONS || 3),
    model = process.env.MODEL || "sonnet";
  const output = path.resolve(
    process.env.BENCHMARK_OUTPUT || path.join(__dirname, "brief-results"),
  );
  fs.mkdirSync(output, { recursive: true });
  const security = new Security(path.join(output, "audits"));
  const selected = cases.filter(
    (c) => !process.env.CASES || process.env.CASES.split(",").includes(c.id),
  );
  const rows = [];
  const started = Date.now();
  const save = () =>
    fs.writeFileSync(
      path.join(output, "results.json"),
      JSON.stringify({ started, ended: Date.now(), repetitions: reps, model, rows }, null, 2),
    );
  for (let rep = 0; rep < reps; rep++)
    for (const c of selected)
      for (const arm of rep % 2 ? ["brief", "sentence"] : ["sentence", "brief"]) {
        const root = fixture(c);
        const before = await security.scan(root);
        const g = before.groups.find((g) => g.rule === c.rule);
        if (before.status !== "completed" || !g)
          throw Error(`${c.id}: scanner did not report ${c.rule} (${before.status})`);
        const task = arm === "brief" ? withBrief(g, security.brief(before.id, g.id)) : sentence(g);
        const engine = new Engine({ dataDir: path.join(output, "runs") });
        const done = new Promise((resolve) => engine.once("done", resolve));
        console.log(`Running ${c.id} repetition ${rep + 1}, ${arm}`);
        await engine.start({
          root,
          task,
          criteria: c.criteria,
          controller: true,
          model,
          effort: "low",
          mode: "economy",
          spend: 0.6,
          tokens: 300000,
          minutes: 4,
          auditId: before.id,
          auditGroups: [g.id],
        });
        const result = await done;
        const after = await security.scan(root, { baseline: before.id });
        const gate = scopedGate(before, after, [g.id]);
        const check = hidden(c, root);
        const visible = c.checks.every(
          (command) =>
            spawnSync(command[0] === "node" ? process.execPath : command[0], command.slice(1), {
              cwd: root,
              timeout: 20000,
            }).status === 0,
        );
        const untouched = Object.keys(c.files)
          .filter((f) => /(^|\/)tests?\//.test(f))
          .every((f) => fs.readFileSync(path.join(root, f), "utf8") === c.files[f]);
        const row = {
          case: c.id,
          repetition: rep + 1,
          arm,
          model: result.model,
          effort: result.effort,
          status: result.status,
          correct: gate === "scanner-cleared" && check.passed && visible && untouched,
          gate,
          hiddenPassed: check.passed,
          checksPassed: visible,
          hiddenOutput: check.passed ? undefined : check.output,
          testsUntouched: untouched,
          promptChars: task.length,
          tokens: usageTokens(result.usage),
          usage: result.usage,
          cost: result.reportedCost,
          toolCalls: result.metrics.toolCalls,
          duplicateReads: result.metrics.duplicateReads,
          elapsedMs: result.elapsedMs,
          run: result.id,
        };
        rows.push(row);
        save();
        console.log(JSON.stringify({ correct: row.correct, gate, hidden: check.passed, status: row.status, tokens: row.tokens, cost: row.cost, toolCalls: row.toolCalls }));
        fs.rmSync(root, { recursive: true, force: true });
      }
  save();
  const summary = summarize(rows);
  fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

function summarize(rows) {
  const arms = {};
  for (const arm of ["sentence", "brief"]) {
    const group = rows.filter((r) => r.arm === arm);
    arms[arm] = {
      runs: group.length,
      correct: group.filter((r) => r.correct).length,
      usageReported: group.filter((r) => r.tokens !== null).length,
      totalTokens: group.reduce((n, r) => n + (r.tokens || 0), 0),
      reportedCost: Number(group.reduce((n, r) => n + (r.cost || 0), 0).toFixed(4)),
      toolCalls: group.reduce((n, r) => n + (r.toolCalls || 0), 0),
    };
  }
  // A pair counts only when both arms of the same case and repetition were correct and fully accounted.
  const pairs = [];
  for (const r of rows.filter((r) => r.arm === "sentence")) {
    const b = rows.find((x) => x.arm === "brief" && x.case === r.case && x.repetition === r.repetition);
    if (b && r.correct && b.correct && r.tokens !== null && b.tokens !== null)
      pairs.push({ case: r.case, repetition: r.repetition, sentence: r.tokens, brief: b.tokens, sentenceCost: r.cost, briefCost: b.cost });
  }
  const s = pairs.reduce((n, p) => n + p.sentence, 0),
    b = pairs.reduce((n, p) => n + p.brief, 0);
  return {
    arms,
    matchedPairs: pairs.length,
    pairs,
    matchedReduction: pairs.length ? Number((1 - b / s).toFixed(4)) : null,
    note: "Reduction covers only matched pairs where both arms were correct and reported usage. All attempts remain in results.json.",
  };
}

if (require.main === module)
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
module.exports = { cases, sentence, withBrief, summarize };
