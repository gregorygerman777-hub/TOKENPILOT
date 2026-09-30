const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLocalServer } = require("../src/server.cjs");
test("local backend requires same-origin bearer access and returns real scan lifecycle", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-server-"));
  let rows = [],
    finish;
  const security = {
    history: () => rows,
    capabilities: () => ({ semgrep: { available: true } }),
    stop: () => finish?.(),
    get: (id) => {
      const r = rows.find((r) => r.id === id);
      if (!r) throw Error("not found");
      return r;
    },
    scan: async (root, { onProgress }) => {
      const r = {
        id: "00000000-0000-0000-0000-000000000001",
        root,
        started: Date.now(),
        status: "scanning",
        snapshot: { hash: "a", manifest: [], excluded: [] },
        scanners: [],
        findings: [],
        groups: [],
      };
      rows.push(r);
      onProgress(r);
      await new Promise((resolve) => {
        finish = resolve;
      });
      r.status = "stopped";
      return r;
    },
  };
  const app = createLocalServer({ dataDir, security });
  const url = await app.listen(0);
  try {
    assert.equal((await fetch(url + "/")).status, 200);
    assert.equal((await fetch(url + "/api/status")).status, 401);
    assert.equal(
      (
        await fetch(url + "/api/session", {
          headers: { Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    const hostStatus = await new Promise((resolve) => {
      require("node:http").get(
        url + "/api/session",
        { headers: { Host: "evil.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
    });
    assert.equal(hostStatus, 403);
    const { token } = await (await fetch(url + "/api/session")).json();
    const headers = {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    };
    assert.equal(
      (
        await fetch(url + "/api/scans", {
          method: "POST",
          headers,
          body: JSON.stringify({ root: "relative" }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(url + "/api/scans", {
          method: "POST",
          headers,
          body: JSON.stringify({ root: dataDir }),
        })
      ).status,
      202,
    );
    const status = await (await fetch(url + "/api/status", { headers })).json();
    assert.equal(status.active.id, rows[0].id);
    assert.equal(status.history[0].status, "scanning");
    assert.equal(
      (
        await fetch(url + "/api/scans", {
          method: "POST",
          headers,
          body: JSON.stringify({ root: dataDir }),
        })
      ).status,
      409,
    );
    assert.equal(
      (await fetch(url + "/api/stop", { method: "POST", headers, body: "{}" }))
        .status,
      200,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      (await (await fetch(url + "/api/status", { headers })).json()).active,
      null,
    );
    assert.equal(
      (await fetch(url + "/api/scans/" + rows[0].id + "/report", { headers }))
        .status,
      200,
    );
    assert.equal((await fetch(url + "/../src/server.cjs")).status, 404);
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("file uploads stay inside local storage and reject traversal", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-upload-"));
  const app = createLocalServer({ dataDir });
  const url = await app.listen(0);
  try {
    const { token } = await (await fetch(url + "/api/session")).json();
    const headers = {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    };
    const send = (files) =>
      fetch(url + "/api/uploads", {
        method: "POST",
        headers,
        body: JSON.stringify({ files }),
      });
    assert.equal(
      (await send([{ name: "../escape.js", data: "eA==" }])).status,
      400,
    );
    assert.equal(
      (await send([{ name: "C:/escape.js", data: "eA==" }])).status,
      400,
    );
    const response = await send([
      {
        name: "project/file.js",
        data: Buffer.from("const x = 1;").toString("base64"),
      },
    ]);
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(
      fs.readFileSync(path.join(result.root, "project/file.js"), "utf8"),
      "const x = 1;",
    );
    assert.ok(result.root.startsWith(fs.realpathSync(dataDir)));
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
