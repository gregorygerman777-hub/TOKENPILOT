const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
test("Claude MCP initializes and scans an actual single file with persisted evidence", async (t) => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/stdio.js"
  );
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-mcp-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-file-"));
  const file = path.join(root, "actual.js");
  fs.writeFileSync(file, "exports.run = value => eval(value);\n");
  const client = new Client({ name: "tokenpilot-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(__dirname, "../src/security-mcp.mjs")],
    env: { ...process.env, TOKENPILOT_DATA: data },
  });
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    assert.ok(!response.isError, response.content[0].text);
    return JSON.parse(response.content[0].text);
  };
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 7);
    const capabilities = await call("tokenpilot_doctor");
    if (!capabilities.semgrep.available || !capabilities.gitleaks.available) {
      t.skip("Live single-file MCP scan requires Semgrep and Gitleaks");
      return;
    }
    const start = await call("tokenpilot_scan", { path: file });
    assert.ok(start.id);
    let result;
    for (let i = 0; i < 60; i++) {
      result = await call("tokenpilot_results", { runId: start.id });
      if (result.status !== "scanning") break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.equal(result.status, "completed");
    assert.equal(result.findings, 1);
    assert.equal(result.groups[0].file, "actual.js");
    const brief = await client.callTool({
      name: "tokenpilot_brief",
      arguments: { runId: start.id, groupId: result.groups[0].id },
    });
    assert.ok(!brief.isError, brief.content[0].text);
    assert.match(
      brief.content[0].text,
      /Code, actual\.js line 1, function run:\n1: exports\.run = value => eval\(value\);/,
    );
    const saved = JSON.parse(
      fs.readFileSync(path.join(data, "audits", start.id + ".json")),
    );
    assert.equal(saved.snapshot.manifest.length, 1);
    assert.equal(saved.snapshot.scope.kind, "files");
    const exported = await call("tokenpilot_export", {
      runId: start.id,
      directory: path.join(data, "export"),
    });
    assert.ok(fs.existsSync(path.join(exported.directory, "findings.sarif")));
    assert.equal((await call("tokenpilot_history", { path: file })).length, 1);
  } finally {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});
