const { Engine } = require("../src/engine.cjs");
const fs = require("node:fs");
const path = require("node:path");
const base = path.resolve(__dirname, "../../../work/smoke");
fs.mkdirSync(base, { recursive: true });
fs.writeFileSync(path.join(base, "greeting.txt"), "Hello wrld\n");
const engine = new Engine({ dataDir: path.join(base, ".results") });
engine.on("update", (r) => {
  const e = r.events.at(-1);
  if (e && JSON.stringify(e) !== global.last) {
    global.last = JSON.stringify(e);
    console.log(e.type, JSON.stringify(e.data).slice(0, 500));
  }
});
engine.on("done", (r) =>
  console.log(
    "DONE",
    JSON.stringify({
      status: r.status,
      usage: r.usage,
      cost: r.reportedCost,
      result: r.result,
    }),
  ),
);
engine
  .start({
    root: base,
    task: "Fix the typo in greeting.txt from wrld to world. Do not change anything else.",
    criteria: "greeting.txt contains Hello world",
    spend: 0.4,
    minutes: 2,
    model: "sonnet",
  })
  .catch(console.error);
