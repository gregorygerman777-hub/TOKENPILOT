const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { hash, summarize } = require("./policy.cjs");
const { fingerprint } = require("./files.cjs");
function selectChecks(checks, changed, broad) {
  return checks.map((c) => ({
    ...c,
    status:
      c.required !== false ||
      broad ||
      !c.affects ||
      changed.some((f) => c.affects.some((p) => f.startsWith(p)))
        ? "unrun"
        : "skipped",
    reason: "Selected conservatively from project rules and changed paths",
  }));
}
function cacheKey(root, check, env = process.env) {
  if (
    !check.cacheable ||
    check.external !== false ||
    check.inputsClosed !== true
  )
    return null;
  try {
    const executable = check.command[0].includes("/")
      ? path.resolve(root, check.command[0])
      : (env.PATH || "")
          .split(path.delimiter)
          .map((p) => path.join(p, check.command[0]))
          .find((p) => fs.existsSync(p));
    if (!executable) return null;
    return hash([
      fingerprint(root, true),
      hash(fs.readFileSync(fs.realpathSync(executable))),
      {
        command: check.command,
        inputsClosed: check.inputsClosed,
        external: check.external,
        cacheable: check.cacheable,
        timeoutMs: check.timeoutMs,
      },
      process.version,
      process.platform,
      process.arch,
      Object.entries(env).sort(([a], [b]) => a.localeCompare(b)),
    ]);
  } catch {
    return null;
  }
}
function killTree(child, signal = "SIGTERM") {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}
async function execute(
  command,
  root,
  log,
  signal,
  timeout = 120000,
  environment = process.env,
) {
  return new Promise((resolve) => {
    let output = "",
      head = "",
      evidence = "",
      settled = false;
    const file = fs.createWriteStream(log, { mode: 0o600 });
    const child = spawn(command[0], command.slice(1), {
      cwd: root,
      env: environment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const add = (b) => {
      file.write(b);
      const text = b.toString();
      if (head.length < 32000) head = (head + text).slice(0, 32000);
      const important = text
        .split("\n")
        .filter((x) => /error|fail|exception|warning|assert|not ok/i.test(x))
        .join("\n");
      if (important && evidence.length < 64000)
        evidence = (evidence + "\n" + important).slice(0, 64000);
      output = (output + text).slice(-1000000);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    let reason;
    let killer;
    const stop = () => {
      reason = signal?.aborted ? "Stopped" : "Timed out";
      killTree(child);
      killer = setTimeout(() => killTree(child, "SIGKILL"), 1500);
    };
    const timer = setTimeout(stop, timeout);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const done = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killer);
      signal?.removeEventListener("abort", stop);
      file.end();
      resolve({
        code,
        output: summarize(
          output.length >= 1000000
            ? head +
                "\n[Full output in log. Selected error evidence follows.]\n" +
                evidence +
                "\n" +
                output
            : output,
        ),
        error: reason || error,
        log,
      });
    };
    child.on("error", (e) => done(null, e.message));
    child.on("close", (code) => done(code));
  });
}
class Verifier {
  constructor(root, dir, checks, event) {
    this.root = root;
    this.dir = dir;
    this.checks = checks;
    this.event = event;
    this.cache = {};
    try {
      this.cache = JSON.parse(fs.readFileSync(path.join(dir, "cache.json")));
    } catch {}
  }
  async run(check, signal, force = false) {
    const before = cacheKey(this.root, check);
    if (!force && before && this.cache[before]) {
      Object.assign(check, {
        status: "cached",
        reason:
          "Identical declared closed inputs, dependencies, command and environment",
        log: this.cache[before].log,
      });
      this.event("verification", check);
      return check;
    }
    check.status = "running";
    this.event("verification", check);
    const result = await execute(
      check.command,
      this.root,
      path.join(
        this.dir,
        `check-${Date.now()}-${hash(check.id).slice(0, 8)}.log`,
      ),
      signal,
      check.timeoutMs || 120000,
    );
    Object.assign(check, result, {
      status: result.error ? "unrun" : result.code === 0 ? "passed" : "failed",
      reason: result.error || "Executed locally",
    });
    if (
      before &&
      check.status === "passed" &&
      before === cacheKey(this.root, check)
    ) {
      this.cache[before] = { log: result.log };
      fs.writeFileSync(
        path.join(this.dir, "cache.json"),
        JSON.stringify(this.cache),
        { mode: 0o600 },
      );
    }
    this.event("verification", check);
    return check;
  }
}
module.exports = { selectChecks, cacheKey, execute, killTree, Verifier };
