const { _electron: electron } = require("playwright");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert/strict");
(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-lab-ui-")),
    out = path.join(data, "report.html");
  const app = await electron.launch({
    ...(process.env.PACKAGED
      ? {
          executablePath: path.resolve(
            __dirname,
            "../release/mac-arm64/TokenPilot.app/Contents/MacOS/TokenPilot",
          ),
        }
      : { args: [path.resolve(__dirname, "..")] }),
    env: { ...process.env, TOKENPILOT_DATA: data },
  });
  try {
    await app.evaluate(({ dialog }, out) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: out });
    }, out);
    await app.evaluate(({ shell }) => {
      shell.openExternal = async (url) => {
        global.__pilotWebURL = url;
      };
    });
    const page = await app.firstWindow();
    await page.locator('[data-page="security"]').click();
    await page.waitForFunction(() =>
      document.querySelector("#scannerStatus").textContent.includes("semgrep"),
    );
    await page.locator("#web").click();
    let webURL;
    for (let i = 0; i < 40; i++) {
      webURL = await app.evaluate(() => global.__pilotWebURL);
      if (webURL) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(webURL, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await fetch(webURL)).status, 200);
    assert.equal((await fetch(webURL + "/api/status")).status, 401);
    await page.locator("#demo").click();
    await page.waitForFunction(
      () => document.querySelector("#scanStatus").textContent === "completed",
      {},
      { timeout: 60000 },
    );
    assert.equal(await page.locator(".finding").count(), 2);
    assert.match(
      await page.locator("#scanSummary").textContent(),
      /0 model tokens/,
    );
    await page.locator("#auditReport").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#scanStatus").textContent === "Report saved",
    );
    assert.ok(fs.existsSync(out));
    assert.ok(!fs.readFileSync(out, "utf8").includes("<script"));
    await page.locator("[data-repair]").first().click();
    await page.locator("#securityScope").waitFor({ state: "visible" });
    const task = await page.locator("#task").inputValue();
    assert.match(task, /Repair brief prepared locally by TokenPilot/);
    assert.match(task, /\nCode, \S+ line/);
    assert.match(task, /Fix direction: /);
    await page.locator("#clearScope").click();
    assert.ok(await page.locator("#securityScope").isHidden());
    await page.locator('[data-page="security"]').click();
    await page.locator("#rescan").click();
    await page.waitForFunction(
      () => document.querySelector("#scanStatus").textContent === "rejected",
      {},
      { timeout: 60000 },
    );
    assert.match(
      await page.locator("#scanSummary").textContent(),
      /2 findings remain/,
    );
    assert.equal(await page.locator("#auditHistory [data-audit]").count(), 2);
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
        0,
      );
    }
    await page.screenshot({
      path: path.resolve(__dirname, "../docs/security-lab.png"),
      fullPage: true,
    });
    console.log(
      "Security Lab: real sample scan, grouped repair handoff, gate removal, export, unchanged rescan rejection, and responsive layouts passed.",
    );
  } finally {
    await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
