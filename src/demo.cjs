const fs = require("node:fs");
const path = require("node:path");
const { bundle } = require("./evidence.cjs");
async function demo(security, output, onProgress = () => {}) {
  if (fs.existsSync(output))
    throw Error("Demo output already exists; choose a new path.");
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const root = path.join(output, "project");
  fs.mkdirSync(root);
  fs.writeFileSync(
    path.join(root, "config.js"),
    '// Built-in demonstration only. This file is never executed.\nexports.parseConfig = text => eval("(" + text + ")");\n',
  );
  onProgress("Scanning the intentionally unsafe built-in fixture...");
  const before = await security.scan(root);
  bundle(before, path.join(output, "before"));
  if (
    before.status !== "completed" ||
    !before.findings.some((f) => f.rule === "javascript-eval")
  )
    throw Error(
      "Demo baseline did not detect the expected finding. Check scanner availability and before/report.html.",
    );
  onProgress("Applying a fixed, documented JSON-only repair recipe (no AI)...");
  fs.writeFileSync(
    path.join(root, "config.js"),
    "// Accept JSON configuration only; JavaScript expressions are unsupported.\nexports.parseConfig = text => JSON.parse(text);\n",
  );
  onProgress("Rescanning against the captured baseline...");
  const after = await security.scan(root, { baseline: before.id });
  bundle(after, path.join(output, "after"));
  const summary = {
    status: after.status,
    before: before.findings.length,
    after: after.findings.length,
    modelTokens: 0,
    recipe:
      "eval-based configuration parsing replaced by JSON.parse. Input contract is deliberately restricted to JSON.",
    limitation:
      "A predetermined educational repair, not an autonomous AI fix or behavioral proof.",
    reports: { before: "before/report.html", after: "after/report.html" },
  };
  fs.writeFileSync(
    path.join(output, "demo.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  return summary;
}
module.exports = { demo };
