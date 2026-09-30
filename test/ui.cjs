const { _electron: electron } = require("playwright");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert/strict");
(async () => {
  const application = await electron.launch({
    ...(process.env.PACKAGED
      ? {
          executablePath: path.resolve(
            __dirname,
            "../release/mac-arm64/TokenPilot.app/Contents/MacOS/TokenPilot",
          ),
        }
      : { args: [path.resolve(__dirname, "..")] }),
    env: {
      ...process.env,
      TOKENPILOT_DATA: fs.mkdtempSync(path.join(os.tmpdir(), "tokenpilot-ui-")),
    },
  });
  try {
    const page = await application.firstWindow();
    await page.waitForSelector("#connectionLabel");
    await page.waitForFunction(
      () =>
        document.querySelector("#connectionLabel").textContent !==
        "Checking Claude Code…",
    );
    await page.locator('[data-mode="balanced"]').click();
    assert.equal(await page.locator("#minutes").inputValue(), "20");
    await page.locator('[data-page="connection"]').click();
    assert.ok(await page.locator("#connection").isVisible());
    await page.locator('[data-page="history"]').click();
    assert.match(
      await page.locator("#historyList").textContent(),
      /appear here/,
    );
    await page.locator('[data-page="workspace"]').click();
    await page.locator("#task").fill("Example task");
    await page.locator("#criteria").fill("Example criterion");
    await page.locator("#run").click();
    assert.match(await page.locator("#error").textContent(), /project first/);
    await page.locator("summary").first().click();
    assert.ok(await page.locator("#tokens").isVisible());
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.send("approval", {
        id: 900,
        kind: "command",
        command: ["echo", "test"],
        reason: "UI-only approval regression check",
      }),
    );
    await page.locator('#approval button[value="allow"]').click();
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.send("approval", {
        id: 901,
        kind: "command",
        command: ["echo", "test"],
        reason: "UI-only cancel regression check",
      }),
    );
    await page.locator("#approval").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    assert.notEqual(
      await page.locator("#approval").evaluate((e) => e.returnValue),
      "allow",
    );
    const checks = [];
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      const result = await page.evaluate(() => {
        const d = document.documentElement;
        return {
          width: innerWidth,
          overflow: d.scrollWidth - d.clientWidth,
          emDash: d.outerHTML.includes("—"),
          spacing: [...document.querySelectorAll("main *")].flatMap((e) => {
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
          smallTargets: [...document.querySelectorAll("button,summary")]
            .filter(
              (e) =>
                e.getBoundingClientRect().height > 0 &&
                e.getBoundingClientRect().height < 44,
            )
            .map((e) => e.id),
        };
      });
      assert.equal(result.overflow, 0);
      assert.equal(result.emDash, false);
      assert.equal(result.spacing.length, 0);
      assert.equal(result.smallTargets.length, 0);
      checks.push(result);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator("summary").first().click();
    await page.locator("#task").fill("");
    await page.locator("#criteria").fill("");
    await page.evaluate(() => (document.querySelector("#error").hidden = true));
    await page.screenshot({
      path: path.resolve(__dirname, "../docs/interface.png"),
      fullPage: true,
    });
    fs.writeFileSync(
      path.resolve(__dirname, "../docs/ui-validation.json"),
      JSON.stringify(checks, null, 2),
    );
    console.log(
      "UI interactions, 4 viewport sizes, spacing, target sizes, and overflow passed.",
    );
  } finally {
    await application.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
