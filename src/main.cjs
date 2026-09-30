const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  powerMonitor,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { Engine } = require("./engine.cjs");
const { connection, binary } = require("./claude.cjs");
const { readConfig, detectChecks } = require("./files.cjs");
process.env.PATH = [
  path.join(os.homedir(), ".local/bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  process.env.PATH,
].join(":");
app.setName("TokenPilot");
const { Security, scopedGate } = require("./security.cjs");
const { report } = require("./report.cjs");
let win, engine, dataDir, security, webServer, webURL;
let recent = [];
const pending = new Map();
let counter = 0;
function send(type, data) {
  if (win && !win.isDestroyed()) win.webContents.send(type, data);
}
async function approve(request) {
  const id = ++counter;
  send("approval", { id, ...request });
  return new Promise((resolve) => pending.set(id, resolve));
}
app.whenReady().then(() => {
  dataDir =
    process.env.TOKENPILOT_DATA || path.join(app.getPath("userData"), "tasks");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    recent = JSON.parse(fs.readFileSync(path.join(dataDir, "recent.json")));
  } catch {}
  security = new Security(path.join(dataDir, "audits"));
  engine = new Engine({
    dataDir,
    approve,
    validateResult: async (r, signal) => {
      const after = await security.scan(r.root, {
        baseline: r.auditId,
        signal,
        onProgress: (r) => send("audit", r),
      });
      after.gateStatus = scopedGate(
        security.get(r.auditId),
        after,
        r.auditGroups,
      );
      after.scope = r.auditGroups;
      security.save(after);
      send("audit", after);
      return after;
    },
  });
  powerMonitor.on("suspend", () => {
    engine.stop("stopped", "Mac went to sleep. Resume when ready.");
    security.stop();
  });
  engine.on("update", (r) => send("task", r));
  engine.on("done", (r) => {
    for (const resolve of pending.values()) resolve(false);
    pending.clear();
    send("task", r);
    send("idle", true);
  });
  win = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 720,
    minHeight: 580,
    title: "TokenPilot",
    backgroundColor: "#f4f3ed",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, "../ui/index.html"));
  win.on("close", (e) => {
    if (security.active) {
      e.preventDefault();
      security.stop();
      return;
    }
    if (engine.active) {
      e.preventDefault();
      dialog
        .showMessageBox(win, {
          type: "question",
          buttons: ["Keep running", "Stop and quit"],
          message: "A task is running. Stop it before closing?",
        })
        .then(({ response }) => {
          if (response === 1) {
            engine.stop();
            engine.once("done", () => app.quit());
          }
        });
    }
  });
  const handle = (name, fn) =>
    ipcMain.handle(name, async (event, ...args) => {
      if (event.sender !== win.webContents) throw Error("Unknown sender");
      return fn(...args);
    });
  handle("init", () => ({
    connection: connection(),
    recent,
    history: engine.history(),
    active: engine.active?.record,
  }));
  handle("choose", async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
    });
    if (result.canceled) return null;
    const root = fs.realpathSync(result.filePaths[0]);
    recent = [root, ...recent.filter((x) => x !== root)].slice(0, 12);
    fs.writeFileSync(
      path.join(dataDir, "recent.json"),
      JSON.stringify(recent),
      { mode: 0o600 },
    );
    return root;
  });
  handle("start", (input) => {
    if (security.active) throw Error("Wait for the active security scan.");
    if (
      input.auditId &&
      security.get(input.auditId).root !== fs.realpathSync(input.root)
    )
      throw Error("Security baseline belongs to a different project");
    return engine.start(input);
  });
  handle("stop", () => {
    engine.stop();
    security.stop();
  });
  handle("answer", ({ id, allow }) => {
    pending.get(id)?.(!!allow);
    pending.delete(id);
  });
  handle("config", (root) => ({
    ...readConfig(root),
    detected: detectChecks(root),
  }));
  handle("saveConfig", ({ root, text }) => {
    if (engine.active)
      throw Error("Stop the task before changing project rules.");
    const c = JSON.parse(text);
    if (!Array.isArray(c.checks)) throw Error("checks must be an array");
    for (const check of c.checks)
      if (
        !check.id ||
        !Array.isArray(check.command) ||
        !check.command.every((x) => typeof x === "string")
      )
        throw Error("Each check needs an id and command array.");
    fs.writeFileSync(
      require("./files.cjs").safe(
        fs.realpathSync(root),
        "tokenpilot.json",
        true,
      ),
      JSON.stringify(c, null, 2) + "\n",
    );
    return true;
  });
  handle("logs", (id) => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("Invalid task id");
    shell.openPath(path.join(dataDir, id));
  });
  handle("login", async () => {
    const quote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
    const login = path.join(app.getPath("userData"), "Claude login.command");
    fs.writeFileSync(login, `#!/bin/sh\n${quote(binary())} auth login\n`, {
      mode: 0o700,
    });
    await shell.openPath(login);
  });
  handle("connect", () => connection());
  handle("scan", async ({ root, baseline }) => {
    if (engine.active) throw Error("Wait for the active agent task.");
    return security.scan(root, {
      baseline,
      onProgress: (r) => send("audit", r),
    });
  });
  handle("demo", () => {
    if (engine.active || security.active)
      throw Error("Wait for the active run.");
    const root = path.join(
      dataDir,
      "demos",
      require("node:crypto").randomUUID(),
      "sample-project",
    );
    fs.mkdirSync(root, { recursive: true });
    for (const name of fs.readdirSync(path.join(__dirname, "../demo")))
      fs.copyFileSync(
        path.join(__dirname, "../demo", name),
        path.join(root, name),
      );
    return fs.realpathSync(root);
  });
  handle("security", () => ({
    capabilities: security.capabilities(),
    history: security.history(),
  }));
  handle("scanStop", () => security.stop());
  handle("brief", ({ id, groupId }) => security.brief(id, groupId));
  handle("web", async () => {
    if (!webServer) {
      webServer = require("./server.cjs").createLocalServer({
        dataDir,
        security,
        canScan: () => !engine.active,
      });
      webURL = await webServer.listen(0);
    }
    await shell.openExternal(webURL);
    return webURL;
  });
  handle("exportReport", async ({ id, kind }) => {
    const r =
      kind === "audit"
        ? security.get(id)
        : engine.history().find((x) => x.id === id);
    if (!r) throw Error("Run not found");
    const result = await dialog.showSaveDialog(win, {
      defaultPath: `TokenPilot-${id.slice(0, 8)}.html`,
      filters: [{ name: "Offline HTML report", extensions: ["html"] }],
    });
    if (result.canceled) return null;
    fs.writeFileSync(result.filePath, report(r), { mode: 0o600 });
    return result.filePath;
  });
  handle("resume", async ({ id, escalate }) => {
    const old = engine.history().find((r) => r.id === id);
    if (!old) throw Error("Task not found");
    if (escalate) {
      const spent = old.reportedCost;
      if (spent === null || spent === undefined)
        throw Error(
          "Usage unavailable. Set a new reviewed budget for the handoff.",
        );
      const remaining = old.policy.spend - spent;
      if (require("./policy.cjs").usageTokens(old.usage) >= old.policy.tokens)
        throw Error("No reported token budget remains.");
      if (old.elapsedMs >= old.policy.minutes * 60000)
        throw Error(
          "No time remains for escalation. Review a new task budget.",
        );
      if (remaining < 0.01)
        throw Error("No reported budget remains for escalation.");
      return engine.start({
        ...old.policy,
        auditId: old.auditId,
        auditGroups: old.auditGroups,
        root: old.root,
        task: old.task,
        criteria: old.criteria,
        effort: "high",
        tokens: Math.max(
          100,
          old.policy.tokens - require("./policy.cjs").usageTokens(old.usage),
        ),
        spend: remaining,
        handoff: `Prior changes and evidence: ${old.escalation?.handoff || old.result}\nUnresolved: ${old.escalation?.reason || old.stopReason}`,
        minutes: Math.max(
          0.05,
          old.policy.minutes - (old.elapsedMs || 0) / 60000,
        ),
      });
    }
    if (!old.sessionId) throw Error("No resumable session was reported.");
    return engine.start({
      ...old.policy,
      auditId: old.auditId,
      auditGroups: old.auditGroups,
      root: old.root,
      task: old.task,
      criteria: old.criteria,
      resume: old.sessionId,
    });
  });
});
app.on("before-quit", () => {
  webServer?.close();
});
app.on("window-all-closed", () => app.quit());
