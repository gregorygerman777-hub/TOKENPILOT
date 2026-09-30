const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  limits,
  risk,
  Guard,
  summarize,
  usageTokens,
} = require("../src/policy.cjs");
const {
  cacheKey,
  selectChecks,
  Verifier,
  execute,
} = require("../src/verify.cjs");
const { safe } = require("../src/files.cjs");
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tokenpilot-test-"));
test("budget values are bounded; risky work escalates regardless of diff size", () => {
  assert.equal(limits({ spend: -9 }).spend, 0.01);
  assert.equal(limits({ minutes: 999 }).minutes, 240);
  assert.equal(limits({ mode: "bad" }).mode, "economy");
  assert.ok(risk("change auth permission").broad);
});
test("unchanged repeat loops block; new input state permits progress", () => {
  const g = new Guard(limits({ repeats: 2 }));
  g.check("read", { path: "a" }, "x");
  g.check("read", { path: "a" }, "x");
  assert.throws(() => g.check("read", { path: "a" }, "x"), /Repeated/);
  g.check("read", { path: "a" }, "y");
});
test("tool call cap is enforced independently of repeat detection", () => {
  const g = new Guard({ ...limits(), calls: 1 });
  g.check("read", {}, "a");
  assert.throws(() => g.check("search", {}, "b"), /limit/);
});
test("usage categories do not count reasoning twice", () => {
  assert.equal(
    usageTokens({
      input_tokens: 1,
      output_tokens: 20,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 4,
      output_tokens_details: { thinking_tokens: 10 },
    }),
    28,
  );
  assert.equal(usageTokens(null), null);
});
test("output compression retains failure evidence and both ends", () => {
  const s = summarize(
    "start\n" +
      "normal\n".repeat(300) +
      "ERROR broken\n" +
      "normal\n".repeat(300) +
      "end",
    1000,
  );
  assert.match(s, /ERROR broken/);
  assert.ok(s.startsWith("start"));
  assert.ok(s.endsWith("end"));
});
test("verification cache invalidates source, dependencies, config, arguments and environment", () => {
  const root = temp();
  fs.writeFileSync(path.join(root, "a"), "x");
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(path.join(root, "node_modules", "dep"), "1");
  const c = {
    id: "unit",
    command: [process.execPath, "a"],
    cacheable: true,
    external: false,
    inputsClosed: true,
  };
  const k = () => cacheKey(root, c, { TZ: "UTC" });
  const first = k();
  fs.writeFileSync(path.join(root, "a"), "y");
  assert.notEqual(k(), first);
  const second = k();
  fs.writeFileSync(path.join(root, "node_modules", "dep"), "2");
  assert.notEqual(k(), second);
  const third = k();
  fs.writeFileSync(path.join(root, "config.json"), "{}");
  assert.notEqual(k(), third);
  assert.notEqual(
    k(),
    cacheKey(root, { ...c, command: [process.execPath, "b"] }, { TZ: "UTC" }),
  );
  assert.notEqual(k(), cacheKey(root, c, { TZ: "EST" }));
  assert.equal(cacheKey(root, { ...c, external: true }), null);
  assert.equal(cacheKey(root, { ...c, inputsClosed: false }), null);
});
test("required and uncertain checks stay selected; broader risk includes optional checks", () => {
  const checks = [
    { id: "required", required: true, affects: ["src"] },
    { id: "optional", required: false, affects: ["web/"] },
  ];
  assert.deepEqual(
    selectChecks(checks, ["docs/readme"], false).map((c) => c.status),
    ["unrun", "skipped"],
  );
  assert.deepEqual(
    selectChecks(checks, [], true).map((c) => c.status),
    ["unrun", "unrun"],
  );
});
test("successful closed check is cached, changed source reruns, unknown inputs never cached", async () => {
  const root = temp(),
    dir = temp();
  fs.writeFileSync(path.join(root, "source"), "a");
  const check = {
    id: "ok",
    command: [process.execPath, "-e", 'console.log("ok")'],
    cacheable: true,
    external: false,
    inputsClosed: true,
  };
  const v = new Verifier(root, dir, [check], () => {});
  assert.equal((await v.run(check)).status, "passed");
  assert.equal((await v.run(check)).status, "cached");
  fs.writeFileSync(path.join(root, "source"), "b");
  assert.equal((await v.run(check)).status, "passed");
  assert.equal((await v.run({ ...check, external: true })).status, "passed");
});
test("failed check cannot become cached or passed", async () => {
  const root = temp(),
    dir = temp(),
    check = {
      id: "bad",
      command: [process.execPath, "-e", "process.exit(1)"],
      cacheable: true,
      external: false,
      inputsClosed: true,
    };
  const v = new Verifier(root, dir, [check], () => {});
  assert.equal((await v.run(check)).status, "failed");
  assert.equal((await v.run(check)).status, "failed");
});
test("stop terminates local verification without reporting success", async () => {
  const abort = new AbortController(),
    root = temp();
  setTimeout(() => abort.abort(), 60);
  const r = await execute(
    [process.execPath, "-e", "setInterval(()=>{},1000)"],
    root,
    path.join(root, "log"),
    abort.signal,
  );
  assert.equal(r.error, "Stopped");
  assert.notEqual(r.code, 0);
});
test("file boundary rejects traversal, protected paths, and symlinks", () => {
  const root = temp();
  assert.throws(() => safe(root, "../outside"));
  assert.throws(() => safe(root, ".git/config"));
  assert.throws(() => safe(root, ".env"));
  fs.symlinkSync(os.tmpdir(), path.join(root, "link"));
  assert.throws(() => safe(root, "link/x"));
});
