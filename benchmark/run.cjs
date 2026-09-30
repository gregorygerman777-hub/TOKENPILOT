const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { Engine } = require("../src/engine.cjs");
const { usageTokens } = require("../src/policy.cjs");
const cases = [
  {
    id: "routine",
    task: "Correct the spelling of wrld to world in greeting.txt.",
    criteria: "greeting.txt contains Hello world",
    files: { "greeting.txt": "Hello wrld\n" },
    assert: (root) =>
      fs.readFileSync(path.join(root, "greeting.txt"), "utf8") ===
      "Hello world\n",
  },
  {
    id: "logic",
    task: "Update clamp so values below the minimum return the minimum and values above maximum return maximum. Preserve values inside the range.",
    criteria: "clamp respects both bounds and preserves in-range values",
    files: {
      "index.cjs": "exports.clamp = (n, min, max) => Math.min(n, max);\n",
      "check.cjs":
        "const assert=require('node:assert/strict');const {clamp}=require('./index.cjs');assert.equal(clamp(-2,0,5),0);assert.equal(clamp(8,0,5),5);assert.equal(clamp(3,0,5),3);\n",
    },
    assert: (root) => {
      const f = requireFresh(root).clamp;
      return f(-9, 0, 4) === 0 && f(99, 0, 4) === 4 && f(2, 0, 4) === 2;
    },
  },
  {
    id: "debug",
    task: "Fix the regression: average([2,4]) returns 2 instead of 3. Empty arrays should return 0. Run the regression check.",
    criteria:
      "average returns the arithmetic mean and returns 0 for an empty array",
    files: {
      "index.cjs":
        "exports.average = xs => xs.reduce((a,b)=>a+b,0) / (xs.length + 1);\n",
      "check.cjs":
        "const assert=require('node:assert/strict');const {average}=require('./index.cjs');assert.equal(average([2,4]),3);assert.equal(average([]),0);\n",
    },
    assert: (root) => {
      const f = requireFresh(root).average;
      return f([3, 7, 8]) === 6 && f([]) === 0;
    },
  },
  {
    id: "broad-validation",
    task: "Fix the public API parseCount to reject negative numbers, fractional values and non-numbers with TypeError. Preserve valid nonnegative integers. This public interface needs all project validation.",
    criteria:
      "parseCount rejects invalid values with TypeError and accepts nonnegative integers\nAll configured verification checks pass",
    files: {
      "index.cjs": "exports.parseCount = value => Number(value);\n",
      "check.cjs":
        "const assert=require('node:assert/strict');const {parseCount}=require('./index.cjs');assert.equal(parseCount(2),2);assert.throws(()=>parseCount(-1),TypeError);assert.throws(()=>parseCount('2'),TypeError);\n",
      "integration.cjs":
        "const assert=require('node:assert/strict');const {parseCount}=require('./index.cjs');assert.equal([0,1,2].map(parseCount).reduce((a,b)=>a+b),3);assert.throws(()=>parseCount(1.5),TypeError);assert.throws(()=>parseCount(NaN),TypeError);\n",
    },
    assert: (root) => {
      const f = requireFresh(root).parseCount;
      for (const x of [-1, 1.2, "3", null, NaN, Infinity]) {
        try {
          f(x);
          return false;
        } catch (e) {
          if (!(e instanceof TypeError)) return false;
        }
      }
      return f(0) === 0 && f(3) === 3;
    },
  },
];
function requireFresh(root) {
  const p = path.join(root, "index.cjs");
  delete require.cache[p];
  return require(p);
}
async function main() {
  const reps = Number(process.env.REPETITIONS || 2),
    model = process.env.MODEL || "sonnet";
  const output = path.resolve(
    process.env.BENCHMARK_OUTPUT || path.join(__dirname, "results"),
  );
  fs.mkdirSync(output, { recursive: true });
  const rows = [];
  const start = Date.now();
  for (let rep = 0; rep < reps; rep++)
    for (const c of cases.filter(
      (c) => !process.env.CASES || process.env.CASES.split(",").includes(c.id),
    ))
      for (const controller of rep % 2 ? [false, true] : [true, false]) {
        const root = fs.mkdtempSync(
          path.join(os.tmpdir(), "tokenpilot-bench-"),
        );
        for (const [f, text] of Object.entries(c.files))
          fs.writeFileSync(path.join(root, f), text);
        const checks = ["check.cjs", "integration.cjs"]
          .filter((f) => c.files[f])
          .map((f) => ({
            id: f,
            command: [process.execPath, f],
            required: true,
            cacheable: true,
            external: false,
            inputsClosed: true,
          }));
        fs.writeFileSync(
          path.join(root, "tokenpilot.json"),
          JSON.stringify({
            rules:
              "Do not modify verification scripts. Only change the implementation or requested text.",
            checks,
          }),
        );
        execFileSync("git", ["init", "-q"], { cwd: root });
        execFileSync("git", ["add", "."], { cwd: root });
        execFileSync(
          "git",
          [
            "-c",
            "user.name=TokenPilot",
            "-c",
            "user.email=benchmark@localhost",
            "commit",
            "-qm",
            "fixture",
          ],
          { cwd: root },
        );
        const engine = new Engine({ dataDir: path.join(output, "runs") });
        const done = new Promise((resolve) => engine.once("done", resolve));
        console.log(
          `Running ${c.id} repetition ${rep + 1}, controller ${controller ? "on" : "off"}`,
        );
        await engine.start({
          root,
          task: c.task,
          criteria: c.criteria,
          controller,
          model,
          effort: "low",
          mode: "economy",
          spend: 0.6,
          tokens: 200000,
          minutes: 3,
        });
        const result = await done;
        let correct = false;
        try {
          correct =
            c.assert(root) &&
            Object.entries(c.files)
              .filter(
                ([f]) => f.endsWith("check.cjs") || f === "integration.cjs",
              )
              .every(
                ([f, text]) =>
                  fs.readFileSync(path.join(root, f), "utf8") === text,
              );
        } catch {}
        const row = {
          case: c.id,
          repetition: rep + 1,
          controller,
          model: result.model,
          effort: result.effort,
          correct,
          completed: result.status === "completed",
          status: result.status,
          tokens: usageTokens(result.usage),
          usage: result.usage,
          cost: result.reportedCost,
          elapsedMs: result.elapsedMs,
          controllerCpuMs: result.controllerCpuMs,
          toolCalls: result.metrics.toolCalls,
          controllerModelTokens: 0,
          run: result.id,
        };
        rows.push(row);
        fs.writeFileSync(
          path.join(output, "results.json"),
          JSON.stringify(
            {
              started: start,
              ended: Date.now(),
              repetitions: reps,
              model,
              rows,
            },
            null,
            2,
          ),
        );
        console.log(
          JSON.stringify({
            correct,
            status: row.status,
            tokens: row.tokens,
            cost: row.cost,
          }),
        );
      }
  const summary = {};
  for (const enabled of [true, false]) {
    const group = rows.filter((r) => r.controller === enabled);
    const successes = group.filter((r) => r.correct && r.completed).length;
    const total = group.reduce((n, r) => n + (r.tokens || 0), 0);
    summary[enabled ? "enabled" : "disabled"] = {
      runs: group.length,
      correctCompleted: successes,
      totalTokens: total,
      tokensPerCorrectCompletion:
        successes && group.every((r) => r.tokens !== null)
          ? total / successes
          : null,
      allUsageReported: group.every((r) => r.tokens !== null),
    };
  }
  fs.writeFileSync(
    path.join(output, "summary.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log(summary);
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
