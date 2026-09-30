const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { scopedGate } = require("./security.cjs");
const { usageTokens } = require("./policy.cjs");

const git = (cwd, args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 50 * 1024 * 1024,
  });

const repairTask = (g, brief) =>
  `Review and fix ${g.rule} in ${g.file}. Preserve intended behavior. Do not hide findings or modify scanner configuration. Report false positives honestly. The selected group must clear without introducing new findings. Required project checks must pass.\n\n${brief.text}`;
const repairCriteria = (g) =>
  `The unsafe behavior in ${g.file} is resolved without suppressing scanner rules\nRequired project checks pass`;

// Default repairer: a budgeted Claude session through the TokenPilot engine.
function engineRepairer({ dataDir, limits = {} }) {
  const { Engine } = require("./engine.cjs");
  return async ({ root, task, criteria, auditId, auditGroups, validate }) => {
    const engine = new Engine({ dataDir, validateResult: validate });
    const done = new Promise((resolve) => engine.once("done", resolve));
    await engine.start({
      root,
      task,
      criteria,
      controller: true,
      model: limits.model || "sonnet",
      effort: limits.effort || "low",
      mode: "economy",
      spend: limits.spend ?? 0.6,
      tokens: limits.tokens ?? 300000,
      minutes: limits.minutes ?? 6,
      auditId,
      auditGroups,
    });
    return done;
  };
}

function reason(run, evidence) {
  if (run.status === "completed") return null;
  const gate = evidence?.gateStatus;
  if (gate === "rejected") {
    const c = evidence.comparison || {};
    if (evidence.evasion?.length)
      return "Gate rejected a suppression or test-detection pattern.";
    if (c.introduced?.length)
      return `Gate rejected: ${c.introduced.length} new finding${c.introduced.length === 1 ? "" : "s"} introduced.`;
    return "Gate rejected: the selected finding is still reported.";
  }
  if (gate === "incomplete") return "Gate incomplete: scanner coverage changed or failed.";
  const failing = (run.checks || []).filter(
    (c) => c.required !== false && !["passed", "cached"].includes(c.status),
  );
  if (failing.length && run.checks.some((c) => c.status === "failed"))
    return `Required checks failing: ${failing.map((c) => c.id).join(", ")}.`;
  if (run.status === "budget_exhausted")
    return run.stopReason || "Budget or time limit reached before a verified fix.";
  const blocked = [...(run.events || [])].reverse().find((e) => e.type === "blocked");
  return (
    run.stopReason ||
    (blocked ? `Stopped after blocked action: ${blocked.data}` : null) ||
    `Repair session ended with status ${run.status} without a verified fix.`
  );
}

// Scan -> brief -> budgeted repair -> gate -> keep or revert, on a private clone.
async function repairAll(
  source,
  { security, dataDir, output, repairer, limits = {}, max = 20, onProgress = () => {} },
) {
  source = fs.realpathSync(source);
  if (!git(source, ["rev-parse", "--is-inside-work-tree"]).includes("true"))
    throw Error("Repair needs a Git repository so rejected patches can be reverted.");
  if (git(source, ["status", "--porcelain"]).trim())
    throw Error("Commit or stash local changes first. Repairs start from the committed HEAD.");
  output = path.resolve(output);
  if (output === source || output.startsWith(source + path.sep))
    throw Error("Write the report outside the project.");
  if (fs.existsSync(output)) throw Error("Output directory already exists; choose a new path.");
  fs.mkdirSync(output, { recursive: true });
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tokenpilot-repair-")));
  git(os.tmpdir(), ["clone", "--quiet", "--no-hardlinks", source, work]);
  const commit = git(work, ["rev-parse", "HEAD"]).trim();
  const who = ["-c", "user.name=TokenPilot", "-c", "user.email=tokenpilot@localhost"];
  repairer ||= engineRepairer({ dataDir, limits });

  const started = Date.now();
  onProgress({ stage: "detect" });
  const scan = await security.scan(work);
  if (scan.status !== "completed")
    throw Error(`Scan ${scan.status}: ${scan.error || "scanner coverage incomplete"}`);
  const repairs = [];
  for (const g of scan.groups.slice(0, max)) {
    onProgress({ stage: "repair", group: g, index: repairs.length, total: Math.min(max, scan.groups.length) });
    const brief = security.brief(scan.id, g.id);
    let evidence = null;
    const validate = async (r, signal) => {
      const after = await security.scan(r.root, { baseline: scan.id, signal });
      after.gateStatus = scopedGate(security.get(scan.id), after, [g.id]);
      after.scope = [g.id];
      security.save(after);
      return (evidence = after);
    };
    let run;
    try {
      run = await repairer({
        root: work,
        task: repairTask(g, brief),
        criteria: repairCriteria(g),
        auditId: scan.id,
        auditGroups: [g.id],
        validate,
        group: g,
        brief,
      });
    } catch (e) {
      run = { status: "failed", stopReason: e.message, checks: [], events: [] };
    }
    const diff = git(work, ["diff", "HEAD", "--no-ext-diff", "--no-textconv"]) +
      git(work, ["ls-files", "--others", "--exclude-standard"])
        .split("\n")
        .filter(Boolean)
        .map((f) => `\nNew file: ${f}\n`)
        .join("");
    const verified =
      run.status === "completed" &&
      ["scanner-cleared", "verified"].includes(evidence?.gateStatus);
    if (verified) {
      git(work, ["add", "-A"]);
      git(work, [...who, "commit", "-qm", `TokenPilot: fix ${g.rule} in ${g.file}`]);
    } else {
      git(work, ["reset", "--hard", "-q"]);
      git(work, ["clean", "-fdq"]);
    }
    repairs.push({
      group: { id: g.id, tool: g.tool, rule: g.rule, file: g.file, lines: g.findings.map((f) => f.line) },
      brief: {
        symbol: brief.blocks.find((b) => b.symbol)?.symbol || null,
        lines: brief.blocks.map((b) => [b.start, b.end]),
        references: brief.callers.length,
        tests: brief.tests,
        hint: brief.hint,
        chars: brief.text.length,
      },
      outcome: verified ? "verified" : "rejected",
      reason: verified ? null : reason(run, evidence),
      gate: evidence
        ? {
            status: evidence.gateStatus,
            remaining: evidence.comparison?.remaining.filter((f) => f.rule === g.rule && f.file === g.file).length ?? null,
            introduced: evidence.comparison?.introduced.length ?? null,
            evasion: evidence.evasion?.length ?? 0,
          }
        : null,
      checks: (run.checks || []).map((c) => ({ id: c.id, status: c.status, required: c.required !== false })),
      diff: diff.trim(),
      tokens: usageTokens(run.usage),
      cost: run.reportedCost ?? null,
      toolCalls: run.metrics?.toolCalls ?? null,
      elapsedMs: run.elapsedMs ?? null,
      model: run.model || null,
      runId: run.id || null,
      summary: verified ? run.result || null : null,
    });
  }
  const patch = git(work, ["diff", commit, "HEAD", "--no-ext-diff", "--no-textconv"]);
  const result = {
    id: scan.id,
    project: path.basename(source),
    source,
    commit,
    started,
    ended: Date.now(),
    scanners: scan.scanners.map((s) => ({ tool: s.tool, version: s.version, status: s.status })),
    files: scan.snapshot.manifest.length,
    findings: scan.findings.map(({ id, tool, rule, file, line, severity, message }) => ({ id, tool, rule, file, line, severity, message })),
    groups: scan.groups.length,
    attempted: repairs.length,
    repairs,
    modelTokensToFind: 0,
    limits: { model: limits.model || "sonnet", effort: limits.effort || "low", spendPerRepair: limits.spend ?? 0.6, max },
  };
  fs.writeFileSync(path.join(output, "fixes.patch"), patch, { mode: 0o600 });
  fs.writeFileSync(path.join(output, "run.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(output, "report.html"), require("./trust.cjs").trustReport(result), { mode: 0o600 });
  fs.rmSync(work, { recursive: true, force: true });
  return { ...result, output };
}

module.exports = { repairAll, repairTask, repairCriteria, reason, engineRepairer };
