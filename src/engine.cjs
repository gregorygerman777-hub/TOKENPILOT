const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const {
  limits,
  Guard,
  risk,
  hash,
  summarize,
  usageTokens,
} = require("./policy.cjs");
const files = require("./files.cjs");
const { Verifier, selectChecks, execute } = require("./verify.cjs");
const claude = require("./claude.cjs");
class Engine extends EventEmitter {
  constructor({
    dataDir,
    runtime = process.execPath,
    bridge = path.join(__dirname, "bridge.mjs"),
    approve = async () => false,
    validateResult = async () => null,
  } = {}) {
    super();
    this.dataDir = dataDir;
    this.runtime = runtime;
    this.bridge = bridge;
    this.approve = approve;
    this.validateResult = validateResult;
    this.active = null;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    for (const r of this.history()) {
      if (r.status === "running") {
        r.status = "interrupted";
        r.stopReason =
          "App ended before a terminal result was saved. Review changes before resuming.";
        fs.writeFileSync(
          path.join(dataDir, r.id + ".json"),
          JSON.stringify(r, null, 2),
          { mode: 0o600 },
        );
      }
    }
  }
  history() {
    return fs
      .readdirSync(this.dataDir)
      .filter((x) => x.endsWith(".json"))
      .flatMap((f) => {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(this.dataDir, f)));
          return r.id ? [r] : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.started - a.started);
  }
  save() {
    if (!this.active) return;
    const r = this.active.record;
    fs.writeFileSync(
      path.join(this.dataDir, r.id + ".json.tmp"),
      JSON.stringify(r, null, 2),
      { mode: 0o600 },
    );
    fs.renameSync(
      path.join(this.dataDir, r.id + ".json.tmp"),
      path.join(this.dataDir, r.id + ".json"),
    );
    this.emit("update", r);
  }
  event(type, data) {
    if (!this.active) return;
    const event = { time: Date.now(), type, data };
    fs.appendFileSync(
      path.join(this.active.dir, "events.jsonl"),
      JSON.stringify(event) + "\n",
      { mode: 0o600 },
    );
    this.active.record.events.push(event);
    if (this.active.record.events.length > 250)
      this.active.record.events.shift();
    this.save();
  }
  async start(input) {
    if (this.active) throw Error("A task is already running.");
    const root = fs.realpathSync(input.root);
    if (!fs.statSync(root).isDirectory())
      throw Error("Select a project directory");
    if (!input.task?.trim() || !input.criteria?.trim())
      throw Error("Enter a task and acceptance criteria.");
    const policy = limits(input);
    const config = files.readConfig(root);
    const rules = ["CLAUDE.md", "AGENTS.md"]
      .filter((f) => fs.existsSync(path.join(root, f)))
      .map((f) => `${f}:\n${fs.readFileSync(files.safe(root, f), "utf8")}`)
      .join("\n");
    const detected = config.checks.length
      ? config.checks
      : files.detectChecks(root);
    const initial = files.changes(root);
    const assessment = risk(input.task, initial.status.split("\n"));
    if (assessment.broad && policy.effort === "low") policy.effort = "medium";
    const id = crypto.randomUUID(),
      dir = path.join(this.dataDir, id);
    fs.mkdirSync(dir, { mode: 0o700 });
    const record = {
      id,
      root,
      task: input.task,
      criteria: input.criteria,
      policy,
      controller: input.controller !== false,
      started: Date.now(),
      status: "running",
      events: [],
      usage: null,
      reportedCost: null,
      sessionId: null,
      checks: selectChecks(
        detected,
        initial.status.split("\n"),
        assessment.broad,
      ),
      initialChanges: initial,
      changes: initial,
      acceptance: [],
      risk: assessment,
      model: policy.model,
      effort: policy.effort,
      metrics: {
        toolCalls: 0,
        duplicateReads: 0,
        blockedActions: 0,
        retries: 0,
        localModelTokens: 0,
        verificationRuns: 0,
        cacheHits: 0,
      },
      auditId: input.auditId || null,
      auditGroups: input.auditGroups || [],
      resumedFrom: input.resume || null,
    };
    const commandInputs = new Set(
      detected
        .flatMap((c) => c.command.slice(1))
        .filter((f) => {
          try {
            return (
              !path.isAbsolute(f) && fs.statSync(files.safe(root, f)).isFile()
            );
          } catch {
            return false;
          }
        }),
    );
    const protectedInputs = input.auditId
      ? new Map(
          files
            .list(root)
            .filter(
              (f) =>
                commandInputs.has(f) ||
                /(^|\/)(tests?|__tests__)\/|(^|\/)test_[^/]+|\.(test|spec)\.|(^|\/)(package\.json|tokenpilot\.json|pytest\.ini|pyproject\.toml)$/.test(
                  f,
                ),
            )
            .map((f) => [f, hash(fs.readFileSync(path.join(root, f)))]),
        )
      : null;
    const active = (this.active = {
      record,
      dir,
      protectedInputs,
      cpuStart: process.cpuUsage(),
      abort: new AbortController(),
      reads: new Map(),
      guard: new Guard(policy, input.controller !== false),
      config,
      finished: false,
      stopping: false,
      queue: Promise.resolve(),
      usageByMessage: new Map(),
      optionalRuns: 0,
    });
    active.verifier = new Verifier(root, dir, record.checks, (t, d) => {
      if (d.status === "running") record.metrics.verificationRuns++;
      if (d.status === "cached") record.metrics.cacheHits++;
      this.event(t, { ...d });
    });
    const key = crypto.randomBytes(32).toString("hex");
    active.server = http.createServer((req, res) => {
      if (
        req.method !== "POST" ||
        req.headers.authorization !== `Bearer ${key}`
      ) {
        res.writeHead(403);
        return res.end("{}");
      }
      let body = "";
      req.on("data", (b) => {
        body += b;
        if (body.length > 2000000) req.destroy();
      });
      req.on("end", () => {
        const work = async () => {
          try {
            const { name, args } = JSON.parse(body);
            if (active.stopping || active.finished)
              throw Error("Task ended. No further tools allowed.");
            const data = await this.tool(name, args);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(data));
          } catch (e) {
            record.metrics.blockedActions++;
            this.event("blocked", e.message);
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
            if (record.metrics.blockedActions >= policy.repeats + 1)
              this.stop(
                "blocked",
                "Repeated blocked actions; review remaining work.",
              );
          }
        };
        active.queue = active.queue.then(work, work);
      });
    });
    await new Promise((resolve) =>
      active.server.listen(0, "127.0.0.1", resolve),
    );
    const mcp = {
      mcpServers: {
        tokenpilot: {
          type: "stdio",
          command: this.runtime,
          args: [this.bridge],
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            TOKENPILOT_ENDPOINT: `http://127.0.0.1:${active.server.address().port}`,
            TOKENPILOT_KEY: key,
          },
        },
      },
    };

    const efficient = record.controller
      ? `Work with the smallest complete change. Search narrowly, read relevant sections, avoid speculative refactors. Reuse evidence already in this session. Do not repeat failed actions without a new hypothesis. Use verify for checks; finish when acceptance is satisfied. Available tool call limit: ${policy.calls}.`
      : "Complete the task using available tools. Use finish when done.";
    const prompt = `Task: ${input.task}\nAcceptance criteria (each nonempty line is one criterion):\n${input.criteria}\n${efficient}\nProject rules, always required:\n${rules}\n${config.rules}\nChecks: ${JSON.stringify(record.checks.map((c) => ({ id: c.id, command: c.command, required: c.required !== false })))}\nRisk: ${JSON.stringify(assessment)}\nAll tools operate on the selected project. Commands require user approval. Never claim a skipped or unrun check passed. If blocked, report what is complete and unresolved. Call finish with an item for every acceptance criterion.\n${input.handoff || ""}`;
    fs.writeFileSync(path.join(dir, "prompt.txt"), prompt, { mode: 0o600 });
    this.event("policy", {
      message: assessment.broad
        ? "Broader validation required: " + assessment.reasons.join(", ")
        : "Start with focused work and conservative required checks",
      policy,
    });
    active.timer = setTimeout(
      () => this.stop("budget_exhausted", "Elapsed time limit reached."),
      policy.minutes * 60000,
    );
    active.process = claude.launch({
      root,
      prompt,
      policy,
      mcp,
      controller: record.controller,
      resume: input.resume,
      onEvent: (event) => this.consume(event),
      onError: (error) => {
        fs.appendFileSync(path.join(dir, "stderr.log"), error, { mode: 0o600 });
        this.event("diagnostic", summarize(error, 2000));
      },
      onClose: (code, signal) => this.closed(code, signal),
    });
    this.save();
    return record;
  }
  consume(e) {
    const a = this.active;
    if (!a) return;
    const r = a.record;
    fs.appendFileSync(
      path.join(a.dir, "agent.jsonl"),
      JSON.stringify(e) + "\n",
      { mode: 0o600 },
    );
    if (e.session_id) r.sessionId = e.session_id;
    if (e.type === "system" && e.subtype === "init") {
      r.model = e.model;
      r.integration = e.mcp_servers;
      if (e.mcp_server_errors?.length)
        this.stop("failed", "TokenPilot tools could not connect");
    }
    if (e.type === "assistant") {
      if (e.message?.usage) a.usageByMessage.set(e.message.id, e.message.usage);
      for (const c of e.message?.content || [])
        if (c.type === "text") this.event("agent", c.text);
      const u = {};
      for (const usage of a.usageByMessage.values())
        for (const k of [
          "input_tokens",
          "output_tokens",
          "cache_creation_input_tokens",
          "cache_read_input_tokens",
        ])
          u[k] = (u[k] || 0) + (usage[k] || 0);
      r.partialUsage = u;
      if (usageTokens(u) >= r.policy.tokens)
        this.stop(
          "budget_exhausted",
          "Reported token threshold reached; in-flight usage may exceed it.",
        );
    }
    if (e.type === "system" && e.subtype === "api_retry") {
      r.metrics.retries++;
      this.event("retry", e);
      if (r.metrics.retries >= r.policy.repeats)
        this.stop("blocked", "Provider retry limit reached.");
    }
    if (e.type === "result") {
      r.usage = e.usage || null;
      r.reportedCost = e.total_cost_usd ?? null;
      r.modelUsage = e.modelUsage || null;
      r.providerResult = e.subtype;
      r.result = e.result || e.errors?.join("\n") || "";
      r.permissionDenials = e.permission_denials || [];
      if (e.is_error && !a.stopping)
        r.status = e.subtype?.includes("budget")
          ? "budget_exhausted"
          : "failed";
      this.event("result", r.result);
    }
    this.save();
  }
  async tool(name, args) {
    const a = this.active,
      r = a.record,
      root = r.root;
    if (Date.now() - r.started >= r.policy.minutes * 60000) {
      this.stop("budget_exhausted", "Elapsed time limit reached.");
      throw Error("Task time limit reached.");
    }
    const fp = files.fingerprint(root);
    a.guard.check(name, args, fp);
    r.metrics.toolCalls++;
    this.event("activity", {
      name,
      args: name === "edit" || name === "write" ? { path: args.path } : args,
    });
    const cap = r.controller ? r.policy.chars : 1000000;
    const output = (value) => {
      fs.appendFileSync(
        path.join(a.dir, "tool-output.jsonl"),
        JSON.stringify({ time: Date.now(), tool: name, args, output: value }) +
          "\n",
        { mode: 0o600 },
      );
      return summarize(value, cap);
    };
    if (name === "discover")
      return output(
        files
          .list(root)
          .filter(
            (f) =>
              f.startsWith(args.prefix || "") &&
              !/(^|\/)\.env|\.claude|\.mcp\.json/.test(f),
          )
          .join("\n"),
      );
    if (name === "search") {
      let found = [];
      for (const f of files
        .list(root)
        .filter((f) => f.startsWith(args.prefix || ""))) {
        let p;
        try {
          p = files.safe(root, f);
        } catch {
          continue;
        }
        if (fs.statSync(p).size > 1000000) continue;
        const t = fs.readFileSync(p, "utf8");
        if (t.includes("\0")) continue;
        t.split("\n").forEach((line, i) => {
          if (line.includes(args.text)) found.push(`${f}:${i + 1}: ${line}`);
        });
        if (found.join("\n").length > cap * 2) break;
      }
      return output(found.join("\n") || "No matches.");
    }
    if (name === "read") {
      const p = files.safe(root, args.path);
      if (fs.statSync(p).size > 4000000)
        throw Error("File exceeds 4 MB. Search narrowly instead.");
      const content = fs.readFileSync(p, "utf8");
      if (content.includes("\0"))
        throw Error("Binary files are not supported by the text tools.");
      const count = Math.min(
        args.lines || 120,
        r.controller ? r.policy.lines : 400,
      );
      const key = hash([args.path, args.start || 1, count, content]);
      if (r.controller && a.reads.has(key)) {
        r.metrics.duplicateReads++;
        return {
          unchanged: true,
          reference: a.reads.get(key),
          message: "This section is unchanged. Reuse the earlier read.",
        };
      }
      a.reads.set(key, args);
      return output(
        content
          .split("\n")
          .slice((args.start || 1) - 1, (args.start || 1) - 1 + count)
          .map((x, i) => `${i + (args.start || 1)}: ${x}`)
          .join("\n"),
      );
    }
    if (name === "edit" || name === "write") {
      if (a.protectedInputs?.has(args.path))
        throw Error(
          "Existing verification inputs are protected during security repair: " +
            args.path,
        );
      if (args.path === "tokenpilot.json")
        throw Error(
          "Verification policy is frozen for this run. Change it in Settings.",
        );
      const p = files.safe(root, args.path, true);
      if (name === "write") {
        if (fs.existsSync(p)) throw Error("File exists. Use edit.");
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, args.content, { flag: "wx" });
      } else {
        const text = fs.readFileSync(p, "utf8");
        if (!args.old || text.split(args.old).length !== 2)
          throw Error(
            "The old text must match exactly once. Read the relevant section.",
          );
        fs.writeFileSync(
          p,
          text.replace(args.old, () => args.replacement),
        );
      }
      r.changes = files.changes(root);
      for (const c of r.checks)
        if (["passed", "cached"].includes(c.status)) {
          c.status = "unrun";
          c.reason = "Files changed after verification";
        }
      this.save();
      return "Saved. Previous verification invalidated.";
    }
    if (name === "verify") return this.verify(args.id);
    if (name === "command") {
      const allowed = await this.approve({
        kind: "command",
        command: args.command,
        reason: args.reason,
        root,
      });
      if (!allowed)
        throw Error("Command denied. Do not retry this blocked action.");
      const result = await execute(
        args.command,
        root,
        path.join(a.dir, `command-${Date.now()}.log`),
        a.abort.signal,
      );
      if (result.code !== 0) {
        a.guard.failures++;
        if (a.guard.failures >= r.policy.repeats)
          this.stop(
            "blocked",
            "Repeated command failures. Review evidence before resuming.",
          );
      }
      r.changes = files.changes(root);
      return { ...result, output: output(result.output) };
    }
    if (name === "escalate") {
      if (r.policy.effort === "high")
        throw Error("Already using high effort. Report unresolved work.");
      const permitted =
        r.policy.autoEscalate ||
        (await this.approve({ kind: "escalation", reason: args.reason, root }));
      r.escalation = { ...args, permitted };
      if (!permitted)
        throw Error("Escalation denied. Finish within the current policy.");
      r.status = "escalation_ready";
      r.stopReason = args.reason;
      a.finished = true;
      a.finishTimer = setTimeout(() => {
        if (this.active === a) a.process.stop();
      }, 30000);
      this.save();
      return "Fresh higher-effort handoff prepared. Return a concise summary now; no further tools are available.";
    }
    if (name === "finish") {
      const criteria = r.criteria
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean);
      if (
        criteria.some(
          (c) =>
            !args.acceptance.some(
              (x) =>
                x.criterion.trim() === c && x.satisfied && x.evidence.trim(),
            ),
        )
      )
        throw Error(
          "Provide satisfied status and evidence for every exact acceptance criterion, or report unresolved work.",
        );
      await this.verify();
      if (
        r.checks.some(
          (c) =>
            c.required !== false && !["passed", "cached"].includes(c.status),
        )
      )
        throw Error(
          "Required checks are not passing. Resolve failures or report incomplete.",
        );
      if (r.auditId) {
        for (const [f, digest] of a.protectedInputs) {
          if (
            !fs.existsSync(path.join(root, f)) ||
            hash(fs.readFileSync(path.join(root, f))) !== digest
          )
            throw Error(
              "Existing verification input changed during security repair: " +
                f +
                ". Restore it or perform this change as a separately reviewed task.",
            );
        }
        r.securityEvidence = await this.validateResult(r, a.abort.signal);
        this.save();
        if (
          !["scanner-cleared", "verified"].includes(
            r.securityEvidence?.gateStatus || r.securityEvidence?.status,
          )
        )
          throw Error(
            "Security verification did not clear. Review remaining findings or incomplete scanner coverage.",
          );
      }
      r.acceptance = args.acceptance;
      r.result = args.summary;
      r.status = "completed";
      a.finished = true;
      this.event("accepted", {
        summary: args.summary,
        acceptance: args.acceptance,
      });
      a.finishTimer = setTimeout(() => {
        if (this.active === a) a.process.stop();
      }, 30000);
      return "Accepted. Stop now. No more tools are permitted.";
    }
    throw Error("Unknown tool");
  }
  async verify(id) {
    const a = this.active,
      r = a.record;
    const broad =
      r.risk.broad || risk("", files.changes(r.root).status.split("\n")).broad;
    const changed = files
      .changes(r.root)
      .status.split("\n")
      .map((x) => x.slice(3));
    const selected = selectChecks(r.checks, changed, broad);
    let results = [];
    if (id && !r.checks.some((c) => c.id === id))
      throw Error("Unknown check id");
    for (let i = 0; i < r.checks.length; i++) {
      const c = r.checks[i];
      if (id && c.id !== id) continue;
      if (!id && selected[i].status === "skipped") {
        if (!["passed", "cached"].includes(c.status)) {
          c.status = "skipped";
          c.reason = "Optional check outside affected paths";
        }
        continue;
      }
      if (
        c.required === false &&
        !broad &&
        a.optionalRuns >= r.policy.optionalChecks
      ) {
        c.status = "skipped";
        c.reason = "Optional verification limit reached";
        continue;
      }
      if (c.required === false) a.optionalRuns++;
      if (a.abort.signal.aborted) break;
      // Avoid duplicate execution in this run only with identical complete repository state and known closed inputs.
      results.push(await a.verifier.run(c, a.abort.signal, !r.controller));
    }
    this.save();
    return results.length
      ? results.map((c) => ({
          id: c.id,
          status: c.status,
          output: c.output,
          reason: c.reason,
        }))
      : {
          message:
            "No checks selected or configured; acceptance is agent-reported, not independently proven.",
        };
  }
  stop(status = "stopped", reason = "Stopped by user") {
    const a = this.active;
    if (!a || a.stopping) return;
    a.stopping = true;
    if (!a.finished) a.record.status = status;
    a.record.stopReason = reason;
    a.abort.abort();
    a.process?.stop();
    this.event("stop", reason);
  }
  closed(code, signal) {
    const a = this.active;
    if (!a) return;
    clearTimeout(a.timer);
    clearTimeout(a.finishTimer);
    a.abort.abort();
    a.server.close();
    a.server.closeAllConnections();
    const r = a.record;
    r.ended = Date.now();
    r.elapsedMs = r.ended - r.started;
    const cpu = process.cpuUsage(a.cpuStart);
    r.controllerCpuMs = (cpu.user + cpu.system) / 1000;
    r.exitCode = code;
    r.signal = signal;
    if (r.status === "running") r.status = "incomplete";
    r.changes = files.changes(r.root);
    if (!r.usage)
      r.accounting =
        "Final usage unavailable. Partial reported usage may omit in-flight work.";
    else
      r.accounting = r.resumedFrom
        ? "Provider session totals may include earlier runs; do not sum resumed runs."
        : "Provider-reported categories; cost is a CLI estimate, not subscription consumption.";
    this.save();
    this.active = null;
    this.emit("done", r);
  }
}
module.exports = { Engine };
