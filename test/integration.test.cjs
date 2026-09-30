const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { Engine } = require("../src/engine.cjs");
const { launch } = require("../src/claude.cjs");
const { limits } = require("../src/policy.cjs");
const temp = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "tokenpilot-integration-"));
test("Claude adapter parses stream and passes explicit resume, policy and tool boundary", async () => {
  const dir = temp(),
    fake = path.join(dir, "cli");
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(path.join(dir, "args"))},JSON.stringify(process.argv.slice(2)));process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'system',session_id:'session',subtype:'init'}));console.log(JSON.stringify({type:'result',usage:{input_tokens:2,output_tokens:3},total_cost_usd:.01}));});`,
    { mode: 0o700 },
  );
  const prior = process.env.TOKENPILOT_CLAUDE;
  process.env.TOKENPILOT_CLAUDE = fake;
  try {
    let events = [];
    await new Promise((resolve) =>
      launch({
        root: dir,
        prompt: "test",
        policy: limits(),
        mcp: {},
        resume: "session",
        onEvent: (e) => events.push(e),
        onError: (e) => assert.fail(e),
        onClose: resolve,
      }),
    );
    assert.equal(events.length, 2);
    const args = JSON.parse(fs.readFileSync(path.join(dir, "args")));
    assert.equal(args[args.indexOf("--resume") + 1], "session");
    assert.equal(args[args.indexOf("--tools") + 1], "");
    assert.ok(args.includes("--strict-mcp-config"));
    assert.ok(args.includes("--max-budget-usd"));
  } finally {
    if (prior) process.env.TOKENPILOT_CLAUDE = prior;
    else delete process.env.TOKENPILOT_CLAUDE;
  }
});
test("usage instrumentation deduplicates assistant ids and stops at delayed threshold", () => {
  const e = new Engine({ dataDir: temp() }),
    dir = temp();
  let stopped = false;
  e.active = {
    dir,
    usageByMessage: new Map(),
    abort: new AbortController(),
    process: {
      stop() {
        stopped = true;
      },
    },
    record: {
      id: "test",
      events: [],
      metrics: { retries: 0 },
      policy: limits({ tokens: 100 }),
      status: "running",
    },
  };
  const event = {
    type: "assistant",
    message: {
      id: "a",
      content: [],
      usage: { input_tokens: 10, output_tokens: 2 },
    },
  };
  e.consume(event);
  e.consume(event);
  assert.equal(e.active.record.partialUsage.input_tokens, 10);
  e.consume({
    type: "assistant",
    message: { id: "b", usage: { input_tokens: 100 }, content: [] },
  });
  assert.equal(e.active.record.status, "budget_exhausted");
  assert.ok(stopped);
});
test("provider result alone does not invent acceptance or completed status", () => {
  const e = new Engine({ dataDir: temp() });
  e.active = {
    dir: temp(),
    record: { id: "test", events: [], metrics: {}, status: "running" },
  };
  e.consume({
    type: "result",
    subtype: "success",
    result: "done",
    usage: { input_tokens: 5 },
    total_cost_usd: 0.1,
  });
  assert.equal(e.active.record.status, "running");
  assert.equal(e.active.record.reportedCost, 0.1);
});
