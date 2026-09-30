const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { execute } = require("./verify.cjs");
const { list, git } = require("./files.cjs");
const { hash } = require("./policy.cjs");
const { diagnose } = require("./diagnose.cjs");

function redact(value) {
  return String(value ?? "")
    .replace(
      /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g,
      "[REDACTED]",
    )
    .replace(
      /((?:password|passwd|api[_-]?key|secret|token)\s*[:=]\s*["'])[^"]*?["']/gi,
      '$1[REDACTED]"',
    );
}
function available(tool) {
  const p =
    [`/opt/homebrew/bin/${tool}`, `/usr/local/bin/${tool}`].find((p) =>
      fs.existsSync(p),
    ) || tool;
  try {
    return {
      available: true,
      binary: p,
      version: execFileSync(p, [tool === "docker" ? "--version" : "version"], {
        encoding: "utf8",
        timeout: 20000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    };
  } catch {
    try {
      return {
        available: true,
        binary: p,
        version: execFileSync(p, ["--version"], {
          encoding: "utf8",
          timeout: 20000,
          stdio: ["ignore", "pipe", "pipe"],
        }).trim(),
      };
    } catch {
      return {
        available: false,
        binary: p,
        reason: "Not installed or could not start",
      };
    }
  }
}
function snapshot(root, destination, files = null) {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const manifest = [],
    excluded = [];
  for (const name of files || list(root)) {
    if (
      [
        ".semgrepignore",
        ".gitleaksignore",
        ".gitignore",
        ".gitleaks.toml",
      ].includes(path.basename(name))
    ) {
      excluded.push({
        name,
        hash: hash(fs.readFileSync(path.join(root, name))),
        reason: "Scanner suppression configuration excluded",
      });
      continue;
    }
    const source = path.join(root, name),
      stat = fs.statSync(source);
    if (stat.size > 4 * 1024 * 1024) {
      excluded.push({ name, reason: "Over 4 MB scan limit" });
      continue;
    }
    const data = fs.readFileSync(source),
      target = path.join(destination, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { mode: 0o600 });
    manifest.push({ path: name, hash: hash(data), bytes: data.length });
  }
  return {
    scope: files ? { kind: "files", files } : { kind: "directory" },
    hash: hash(manifest),
    manifest,
    excluded,
    commit: git(root, ["rev-parse", "HEAD"]).trim() || null,
  };
}
function normalize(tool, data, snapshotRoot) {
  const rows = tool === "semgrep" ? data.results || [] : data;
  if (!Array.isArray(rows))
    throw Error("Scanner returned an invalid findings array");
  return rows.map((f) => {
    const file = String(f.path || f.File || "")
      .replace(snapshotRoot + path.sep, "")
      .replace(/^\.\//, "");
    const rule =
      tool === "semgrep" ? String(f.check_id).split(".").pop() : f.RuleID;
    const line = f.start?.line || f.StartLine || 0;
    return {
      id: hash([tool, rule, file, line]).slice(0, 16),
      tool,
      rule,
      file,
      line,
      severity: f.extra?.severity || "HIGH",
      message: redact(f.extra?.message || f.Description || rule),
      evidence: "static-finding",
    };
  });
}
function group(findings) {
  const map = new Map();
  for (const f of findings) {
    const key = hash([f.tool, f.rule, f.file]).slice(0, 16);
    if (!map.has(key))
      map.set(key, {
        id: key,
        tool: f.tool,
        rule: f.rule,
        file: f.file,
        findings: [],
      });
    map.get(key).findings.push(f);
  }
  return [...map.values()];
}
function compare(before, after) {
  const complete =
    before.scanners.every((s) => s.status === "completed") &&
    after.scanners.every((s) => s.status === "completed") &&
    JSON.stringify(before.snapshot.excluded) ===
      JSON.stringify(after.snapshot.excluded) &&
    JSON.stringify(before.snapshot.scope) ===
      JSON.stringify(after.snapshot.scope) &&
    before.rulesHash === after.rulesHash &&
    JSON.stringify(before.scanners.map((s) => [s.tool, s.version])) ===
      JSON.stringify(after.scanners.map((s) => [s.tool, s.version]));
  const count = (rows) => {
    const m = new Map();
    for (const f of rows) {
      const k = [f.tool, f.rule, f.file].join(":");
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  };
  const b = count(before.findings),
    a = count(after.findings);
  const remaining = after.findings.filter((f) =>
    b.has([f.tool, f.rule, f.file].join(":")),
  );
  const introduced = after.findings.filter(
    (f) =>
      (a.get([f.tool, f.rule, f.file].join(":")) || 0) >
      (b.get([f.tool, f.rule, f.file].join(":")) || 0),
  );
  const cleared = before.groups.filter(
    (g) => !a.has([g.tool, g.rule, g.file].join(":")),
  );
  return {
    status: complete
      ? remaining.length || introduced.length
        ? "rejected"
        : "scanner-cleared"
      : "incomplete",
    cleared,
    remaining,
    introduced,
    complete,
    explanation:
      "Static rule comparison, not evidence that an exploit was reproduced. New or remaining findings block the static gate.",
  };
}

function scopedGate(before, after, ids) {
  const selected = ids?.length
    ? before.groups.filter((g) => ids.includes(g.id))
    : before.groups;
  if (ids?.length && selected.length !== new Set(ids).size)
    throw Error("Unknown finding group");
  if (!after.comparison?.complete) return "incomplete";
  if (after.comparison.introduced.length || after.evasion?.length)
    return "rejected";
  if (
    selected.some((g) =>
      after.groups.some(
        (a) => a.tool === g.tool && a.rule === g.rule && a.file === g.file,
      ),
    )
  )
    return "rejected";
  if (before.proofConfig)
    return after.proof?.status === "verified" ? "verified" : "incomplete";
  return "scanner-cleared";
}
class Security {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.active = null;
  }
  capabilities() {
    return Object.fromEntries(
      ["semgrep", "gitleaks", "docker"].map((t) => [t, available(t)]),
    );
  }
  history() {
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        try {
          return [JSON.parse(fs.readFileSync(path.join(this.dir, f)))];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.started - a.started);
  }
  get(id) {
    if (!/^[\da-f-]{36}$/.test(id)) throw Error("Invalid scan id");
    return JSON.parse(fs.readFileSync(path.join(this.dir, id + ".json")));
  }
  save(record) {
    fs.writeFileSync(
      path.join(this.dir, record.id + ".json"),
      JSON.stringify(record, null, 2),
      { mode: 0o600 },
    );
  }
  stop() {
    this.active?.abort();
  }
  brief(id, groupId) {
    const r = this.get(id);
    if (r.status === "scanning") throw Error("Wait for the scan to finish.");
    const group = r.groups.find((g) => g.id === groupId);
    if (!group) throw Error("Unknown finding group");
    return diagnose({
      tree: path.join(this.dir, r.id, "source"),
      manifest: r.snapshot.manifest,
      group,
      root: r.root,
      redact,
    });
  }
  async scan(root, { baseline = null, signal, onProgress = () => {} } = {}) {
    if (this.active) throw Error("A security scan is already running");
    root = fs.realpathSync(root);
    if (
      path.resolve(this.dir) === root ||
      path.resolve(this.dir).startsWith(root + path.sep)
    )
      throw Error("Choose source outside TokenPilot storage.");
    const id = crypto.randomUUID(),
      dir = path.join(this.dir, id),
      tree = path.join(dir, "source");
    const abort = new AbortController();
    this.active = abort;
    const stop = () => abort.abort();
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) abort.abort();
    const r = {
      id,
      root,
      started: Date.now(),
      status: "scanning",
      snapshot: null,
      scanners: [],
      findings: [],
      groups: [],
      modelTokens: 0,
      baseline,
      proof: { status: "not-configured" },
    };
    try {
      const single = fs.statSync(root).isFile();
      const sourceRoot = single ? path.dirname(root) : root;
      r.snapshot = snapshot(
        sourceRoot,
        tree,
        single ? [path.basename(root)] : null,
      );
      if (!r.snapshot.manifest.length) throw Error("No source files found.");
      const rule = fs.readFileSync(path.join(__dirname, "rules/security.yml"));
      const secretRules = fs.readFileSync(
        path.join(__dirname, "rules/gitleaks.toml"),
      );
      fs.writeFileSync(path.join(dir, "security.yml"), rule);
      fs.writeFileSync(path.join(dir, "gitleaks.toml"), secretRules);
      r.rulesHash = hash(Buffer.concat([rule, secretRules]));
      try {
        r.proofConfig =
          JSON.parse(
            fs.readFileSync(path.join(sourceRoot, "tokenpilot.json"), "utf8"),
          ).proof || null;
      } catch {
        r.proofConfig = null;
      }
      this.save(r);
      onProgress(r);
      const capabilities = this.capabilities();
      for (const tool of ["semgrep", "gitleaks"]) {
        if (abort.signal.aborted) throw Error("Scan stopped");
        const capability = capabilities[tool],
          out = path.join(dir, tool + ".json");
        if (!capability.available) {
          r.scanners.push({
            tool,
            status: "unavailable",
            reason: capability.reason,
          });
          continue;
        }
        const command =
          tool === "semgrep"
            ? [
                capability.binary,
                "scan",
                "--config",
                path.join(dir, "security.yml"),
                "--json",
                "--output",
                out,
                "--metrics",
                "off",
                "--disable-version-check",
                "--disable-nosem",
                "--no-git-ignore",
                tree,
              ]
            : [
                capability.binary,
                "dir",
                tree,
                "--config",
                path.join(dir, "gitleaks.toml"),
                "--report-format",
                "json",
                "--report-path",
                out,
                "--redact=100",
                "--no-banner",
                "--ignore-gitleaks-allow",
              ];
        const result = await execute(
          command,
          dir,
          path.join(dir, tool + ".log"),
          abort.signal,
          120000,
          {
            ...process.env,
            GITLEAKS_CONFIG: "",
            GITLEAKS_CONFIG_TOML: "",
            SEMGREP_APP_TOKEN: "",
            SEMGREP_SEND_METRICS: "off",
          },
        );
        let status = "failed",
          reason = result.error || result.output;
        if (
          !result.error &&
          ((tool === "gitleaks" && [0, 1].includes(result.code)) ||
            (tool === "semgrep" && result.code === 0)) &&
          fs.existsSync(out)
        ) {
          const data = JSON.parse(fs.readFileSync(out, "utf8"));
          r.findings.push(...normalize(tool, data, tree));
          status =
            tool === "semgrep" && data.errors?.length ? "partial" : "completed";
          reason =
            status === "partial"
              ? `${data.errors.length} parse or scan errors`
              : "Scan completed";
          // Do not retain raw Semgrep source excerpts in exported or persisted reports.
          fs.writeFileSync(
            out,
            JSON.stringify(
              { findings: r.findings.filter((f) => f.tool === tool) },
              null,
              2,
            ),
            { mode: 0o600 },
          );
        }
        r.scanners.push({
          tool,
          version: capability.version,
          status,
          exitCode: result.code,
          reason: redact(reason),
          command,
        });
        r.groups = group(r.findings);
        this.save(r);
        onProgress(r);
      }
      r.status = r.scanners.every((s) => s.status === "completed")
        ? "completed"
        : "incomplete";
      if (baseline) {
        const before = this.get(baseline);
        if (before.root !== root)
          throw Error("Baseline belongs to a different project");
        r.comparison = compare(before, r);
        r.evasion = [];
        for (const f of r.snapshot.manifest) {
          const oldPath = path.join(this.dir, before.id, "source", f.path),
            newPath = path.join(tree, f.path);
          const oldLines = new Set(
            fs.existsSync(oldPath)
              ? fs.readFileSync(oldPath, "utf8").split("\n")
              : [],
          );
          const added = fs
            .readFileSync(newPath, "utf8")
            .split("\n")
            .filter((l) => !oldLines.has(l));
          if (
            added.some((l) =>
              /nosemgrep|gitleaks:allow|inspect\.stack|PYTEST_CURRENT_TEST|NODE_ENV.*test|getattr\([^\n]*\+/.test(
                l,
              ),
            )
          )
            r.evasion.push({
              file: f.path,
              reason:
                "New suppression, test-detection, or dynamic-name pattern requires human review",
            });
        }
        if (r.evasion.length) r.comparison.status = "rejected";
        r.status = r.comparison.status;
        if (before.proofConfig) {
          const pre = await this.prove(
            before.id,
            before.proofConfig,
            abort.signal,
          );
          this.save(r);
          const post = await this.prove(r.id, before.proofConfig, abort.signal);
          r.proof = {
            before: pre,
            after: post,
            status:
              pre.status === "failed" &&
              post.status === "passed" &&
              pre.imageId === post.imageId &&
              pre.scriptHash === post.scriptHash
                ? "verified"
                : "not-verified",
          };
          if (r.status === "scanner-cleared")
            r.status =
              r.proof.status === "verified" ? "verified" : "incomplete";
        }
      }
      r.ended = Date.now();
      this.save(r);
      return r;
    } catch (e) {
      r.status = abort.signal.aborted ? "stopped" : "failed";
      r.error = redact(e.message);
      r.ended = Date.now();
      this.save(r);
      return r;
    } finally {
      this.active = null;
      signal?.removeEventListener("abort", stop);
    }
  }
  async prove(id, config, signal) {
    const record = this.get(id);
    const capability = available("docker");
    if (!capability.available)
      return {
        status: "unavailable",
        reason: "Docker is not installed. No behavioral verification ran.",
      };
    if (
      !config?.image ||
      !["python3", "node"].includes(config.runtime) ||
      typeof config.script !== "string"
    )
      throw Error(
        "Proof requires a local Docker image, runtime (python3 or node), and a frozen script.",
      );
    let imageId;
    try {
      imageId = execFileSync(
        capability.binary,
        ["image", "inspect", config.image, "--format", "{{.Id}}"],
        { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
    } catch {
      return {
        status: "unavailable",
        reason:
          "Docker daemon or specified local image unavailable. Images are never pulled automatically.",
      };
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId))
      throw Error("Could not pin image ID");
    const tree = path.join(this.dir, id, "source");
    if (tree.includes(","))
      throw Error("Docker mount paths containing commas are unsupported");
    const name = "tokenpilot-" + crypto.randomUUID();
    const command = [
      capability.binary,
      "run",
      "--rm",
      "--pull=never",
      "--name",
      name,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      "65534:65534",
      "--pids-limit",
      "128",
      "--memory",
      "256m",
      "--cpus",
      "1",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      "--mount",
      `type=bind,src=${tree},dst=/workspace,readonly`,
      "--workdir",
      "/workspace",
      "--entrypoint",
      config.runtime,
      imageId,
      config.runtime === "node" ? "-e" : "-c",
      config.script,
    ];
    // Only the container sees world-readable source files; the parent run directory stays private.
    fs.chmodSync(tree, 0o755);
    for (const f of list(tree)) fs.chmodSync(path.join(tree, f), 0o644);
    const result = await execute(
      command,
      this.dir,
      path.join(this.dir, id, "proof.log"),
      signal,
      60000,
    );
    try {
      execFileSync(capability.binary, ["rm", "-f", name], {
        timeout: 5000,
        stdio: "ignore",
      });
    } catch {}
    return {
      status: result.error
        ? "unrun"
        : result.code === 0
          ? "passed"
          : result.code === 1
            ? "failed"
            : "unrun",
      exitCode: result.code,
      output: redact(result.output),
      imageId,
      scriptHash: hash(config.script),
      reason:
        result.error ||
        "Executed with no network, read-only source and dropped capabilities",
    };
  }
}
module.exports = {
  scopedGate,
  Security,
  normalize,
  group,
  compare,
  redact,
  snapshot,
};
