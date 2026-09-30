const { chromium } = require("playwright");
const { createLocalServer } = require("../src/server.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-web-ui-"));
  const app = createLocalServer({ dataDir: data });
  const url = await app.listen(0);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(url);
    await page.waitForFunction(
      () =>
        document.querySelector("#connection").textContent ===
        "Connected to this Mac",
    );
    await page.locator("#sample").click();
    await page.waitForFunction(
      () => document.querySelector("#status").textContent === "completed",
      null,
      { timeout: 60000 },
    );
    assert.equal(await page.locator(".finding").count(), 2);
    assert.equal(await page.locator(".history-item").count(), 1);
    assert.match(
      await page.locator("#summary").textContent(),
      /0 model tokens/,
    );
    const download = page.waitForEvent("download");
    await page.locator('[data-download="sarif"]').click();
    const d = await download;
    const content = JSON.parse(fs.readFileSync(await d.path(), "utf8"));
    assert.equal(content.runs[0].results.length, 2);
    await page.locator("#compare").click();
    await page.waitForFunction(
      () => document.querySelector("#status").textContent === "rejected",
      null,
      { timeout: 60000 },
    );
    assert.match(
      await page.locator("#summary").textContent(),
      /2 findings remain/,
    );
    assert.equal(await page.locator(".history-item").count(), 2);
    await page.locator("#root").fill("/definitely-missing-tokenpilot-folder");
    await page.locator("#scan").click();
    await page.waitForFunction(() => !document.querySelector("#error").hidden);
    assert.match(await page.locator("#error").textContent(), /not found/);
    await page
      .locator("#files")
      .setInputFiles({
        name: "uploaded.js",
        mimeType: "text/javascript",
        buffer: Buffer.from("exports.run = x => eval(x);\n"),
      });
    await page.waitForFunction(
      () =>
        document.querySelector("#status").textContent === "completed" &&
        document.querySelector("#result-title").textContent ===
          "selected-files",
      null,
      { timeout: 60000 },
    );
    assert.equal(await page.locator(".finding").count(), 1);
    assert.match(
      await page.locator(".finding code").textContent(),
      /uploaded.js/,
    );
    await page.reload();
    await page.waitForFunction(() =>
      document.querySelector("#root").value.includes("selected-files"),
    );
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      const result = await page.evaluate(() => ({
        overflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
        spacing: [
          ...new Set(
            [...document.querySelectorAll("main *")].flatMap((e) => {
              const c = getComputedStyle(e);
              return [
                "paddingTop",
                "paddingBottom",
                "paddingLeft",
                "paddingRight",
                "gap",
                "rowGap",
                "columnGap",
              ]
                .map((k) => parseFloat(c[k]))
                .filter((v) => v > 0 && v % 4 !== 0);
            }),
          ),
        ],
        small: [...document.querySelectorAll("button")].filter(
          (e) =>
            e.getBoundingClientRect().height > 0 &&
            e.getBoundingClientRect().height < 44,
        ).length,
      }));
      assert.equal(result.overflow, 0);
      assert.deepEqual(result.spacing, []);
      assert.equal(result.small, 0);
    }
    assert.deepEqual(errors, []);
    await page.screenshot({
      path: path.resolve(__dirname, "../docs/web-workbench.png"),
      fullPage: true,
    });
    console.log(
      "Live browser: sample, scanner progress, findings, history, SARIF download, unchanged-baseline rejection, path error, and 4 responsive widths passed.",
    );
  } finally {
    await browser.close();
    await app.close();
    fs.rmSync(data, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
