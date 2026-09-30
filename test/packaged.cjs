const { _electron: electron } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
(async () => {
  const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "tokenpilot-packaged-project-"),
    ),
    data = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpilot-packaged-data-"));
  fs.writeFileSync(path.join(root, "greeting.txt"), "Hello wrld\n");
  const configure = (delay) =>
    fs.writeFileSync(
      path.join(root, "tokenpilot.json"),
      JSON.stringify({
        rules: "Only change greeting.txt. The configured check is required.",
        checks: [
          {
            id: "greeting",
            command: [
              process.execPath,
              "-e",
              `setTimeout(()=>require('node:assert/strict').equal(require('node:fs').readFileSync('greeting.txt','utf8'),'Hello world\\n'),${delay})`,
            ],
            required: true,
          },
        ],
      }),
    );
  configure(30000);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=TokenPilot",
      "-c",
      "user.email=test@localhost",
      "commit",
      "-qm",
      "start",
    ],
    { cwd: root },
  );
  const application = await electron.launch({
    executablePath: path.resolve(
      __dirname,
      "../release/mac-arm64/TokenPilot.app/Contents/MacOS/TokenPilot",
    ),
    env: { ...process.env, TOKENPILOT_DATA: data },
  });
  try {
    await application.evaluate(({ dialog }, root) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [root],
      });
    }, root);
    const page = await application.firstWindow();
    await page.waitForFunction(
      () =>
        document.querySelector("#connectionLabel")?.textContent ===
        "Claude Code connected",
    );
    await page.locator("#choose").click();
    await page
      .locator("#task")
      .fill(
        "Fix wrld to world in greeting.txt. Run the required greeting check.",
      );
    await page.locator("#criteria").fill("greeting.txt contains Hello world");
    await page.locator("#run").click();
    await page.locator('[data-tab="verification"]').click();
    await page.waitForFunction(
      () =>
        document.querySelector("#runContent").textContent.includes("running"),
      {},
      { timeout: 120000 },
    );
    await page.locator("#stop").click();
    await page.waitForFunction(
      () => !document.querySelector("#run").disabled,
      {},
      { timeout: 15000 },
    );
    assert.match(await page.locator("#taskStatus").textContent(), /stopped/);
    configure(0);
    await page.locator("#resume").click();
    await page.waitForFunction(
      () => !document.querySelector("#run").disabled,
      {},
      { timeout: 120000 },
    );
    assert.equal(await page.locator("#taskStatus").textContent(), "completed");
    assert.equal(
      fs.readFileSync(path.join(root, "greeting.txt"), "utf8"),
      "Hello world\n",
    );
    await page.locator('[data-tab="changes"]').click();
    assert.match(
      await page.locator("#runContent").textContent(),
      /Hello world/,
    );
    await page.locator('[data-tab="usage"]').click();
    assert.match(
      await page.locator("#runContent").textContent(),
      /cumulative|earlier runs/,
    );
    const records = fs
      .readdirSync(data)
      .filter((f) => f.endsWith(".json") && f !== "recent.json")
      .map((f) => JSON.parse(fs.readFileSync(path.join(data, f))));
    const completed = records.find((r) => r.status === "completed");
    assert.ok(completed.usage);
    assert.ok(completed.checks.every((c) => c.status === "passed"));
    assert.ok(records.some((r) => r.status === "stopped"));
    await page.screenshot({
      path: path.resolve(__dirname, "../docs/packaged-running.png"),
      fullPage: true,
    });
    fs.writeFileSync(
      path.resolve(__dirname, "../docs/packaged-validation.json"),
      JSON.stringify(
        {
          testedAt: new Date().toISOString(),
          checks: [
            "packaged app launches",
            "official Claude login recognized",
            "packaged MCP bridge connects",
            "real project file edited",
            "required verification runs",
            "Stop terminates in-flight verification",
            "Resume uses reported session ID",
            "required verification passes after resume",
            "tracked diff appears",
            "usage and session accounting warning appear",
          ],
          records: records.map((r) => ({
            id: r.id,
            status: r.status,
            usage: r.usage,
            cost: r.reportedCost,
            elapsedMs: r.elapsedMs,
          })),
        },
        null,
        2,
      ),
    );
    console.log(
      "Packaged integration, live file edit, stop, resume, diff, verification and usage passed.",
    );
  } finally {
    try {
      const p = await application.firstWindow();
      await p.evaluate(() => window.pilot.call("stop"));
      await p.waitForFunction(
        () => !document.querySelector("#run").disabled,
        {},
        { timeout: 10000 },
      );
    } catch {}
    await application.evaluate(({ app }) => app.exit(0));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
