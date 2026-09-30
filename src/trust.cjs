const { escape } = require("./report.cjs");

const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
const num = (n) => (n === null || n === undefined ? "not reported" : Number(n).toLocaleString("en-US"));
const usd = (n) => (n === null || n === undefined ? "not reported" : "$" + Number(n).toFixed(4));

function diffHtml(diff) {
  if (!diff) return '<p class="muted">No file changes were left by this attempt.</p>';
  return `<pre class="diff">${diff
    .split("\n")
    .map((l) => {
      const cls = /^(\+\+\+|---|diff |index )/.test(l)
        ? "meta"
        : l.startsWith("+")
          ? "add"
          : l.startsWith("-")
            ? "del"
            : l.startsWith("@@")
              ? "hunk"
              : "";
      return `<span${cls ? ` class="${cls}"` : ""}>${escape(l)}</span>`;
    })
    .join("")}</pre>`;
}

function marks(r) {
  const required = r.checks.filter((c) => c.required);
  const passing = required.filter((c) => ["passed", "cached"].includes(c.status));
  const items = [
    required.length
      ? [passing.length === required.length, `Project checks pass (${required.map((c) => c.id).join(", ")})`]
      : [null, "No project checks configured"],
    [r.gate ? r.gate.remaining === 0 : null, "Original finding gone"],
    [r.gate ? r.gate.introduced === 0 && !r.gate.evasion : null, "No new findings or suppressions"],
  ];
  return `<ul class="marks">${items
    .map(([ok, label]) => `<li class="${ok === true ? "ok" : ok === false ? "no" : "na"}">${ok === true ? "✓" : ok === false ? "✗" : "–"} ${escape(label)}</li>`)
    .join("")}</ul>`;
}

function repairCard(r) {
  const b = r.brief;
  return `<article class="repair ${r.outcome}">
  <div class="head"><code>${escape(r.group.file)}</code><span class="tag ${r.outcome}">${r.outcome === "verified" ? "verified" : "rejected, reverted"}</span></div>
  <p class="rule">${escape(r.group.tool)} · ${escape(r.group.rule)} · line${r.group.lines.length === 1 ? "" : "s"} ${escape(r.group.lines.join(", "))}</p>
  ${marks(r)}
  ${r.reason ? `<p class="reason">${escape(r.reason)}</p>` : ""}
  <dl>
    <div><dt>Brief</dt><dd>${b.symbol ? `function ${escape(b.symbol)}, ` : ""}lines ${escape(b.lines.map(([s, e]) => (s === e ? s : `${s}-${e}`)).join(", "))} · ${b.references} reference${b.references === 1 ? "" : "s"} · ${b.chars} chars · 0 model tokens</dd></div>
    ${b.hint ? `<div><dt>Fix direction</dt><dd>${escape(b.hint)}</dd></div>` : ""}
    <div><dt>Repair cost</dt><dd>${num(r.tokens)} tokens · ${usd(r.cost)} · ${num(r.toolCalls)} tool calls${r.model ? ` · ${escape(r.model)}` : ""}</dd></div>
  </dl>
  ${r.summary ? `<p class="summary">${escape(r.summary)}</p>` : ""}
  <h4>${r.outcome === "verified" ? "The patch" : "The rejected attempt"}</h4>
  ${diffHtml(r.diff)}
</article>`;
}

function trustReport(run) {
  const verified = run.repairs.filter((r) => r.outcome === "verified");
  const rejected = run.repairs.filter((r) => r.outcome !== "verified");
  const tokens = run.repairs.filter((r) => r.tokens !== null);
  const totalTokens = tokens.reduce((n, r) => n + r.tokens, 0);
  const totalCost = run.repairs.reduce((n, r) => n + (r.cost || 0), 0);
  const perFix = verified.length && tokens.length === run.repairs.length ? Math.round(totalTokens / verified.length) : null;
  const outcome = new Map();
  for (const r of run.repairs) outcome.set(`${r.group.tool}:${r.group.rule}:${r.group.file}`, r.outcome);
  const sev = (s) => String(s || "").toLowerCase().replace("error", "high").replace("warning", "medium");
  const stat = (big, label, note) => `<div class="stat"><strong>${big}</strong><span>${label}</span><small>${note}</small></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>TokenPilot trust report</title><style>
:root{--bg:#f4f3ed;--panel:#fff;--ink:#202b28;--muted:#59665f;--line:#d8ddd5;--accent:#25654c;--ok:#1f6b45;--no:#a33a2b;--code:#eeeee7;--add:#dff0e3;--del:#f7e1dc}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#141816;--panel:#1c211e;--ink:#e6ebe7;--muted:#9aa69f;--line:#2f3833;--accent:#6fbf98;--ok:#7ccf9f;--no:#f08a7a;--code:#232a26;--add:#1f3a2a;--del:#442622}}
:root[data-theme="dark"]{--bg:#141816;--panel:#1c211e;--ink:#e6ebe7;--muted:#9aa69f;--line:#2f3833;--accent:#6fbf98;--ok:#7ccf9f;--no:#f08a7a;--code:#232a26;--add:#1f3a2a;--del:#442622}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,sans-serif}main{max-width:960px;margin:auto;padding:48px 16px}
header{border-top:8px solid var(--accent);padding-top:24px}small,.muted{color:var(--muted)}h1{font:40px/1.1 Georgia,serif;margin:8px 0}h2{margin:48px 0 16px;font-size:24px}h4{margin:24px 0 8px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin:32px 0}.stat{background:var(--panel);border:1px solid var(--line);padding:16px;display:flex;flex-direction:column;gap:4px}.stat strong{font:40px/1 Georgia,serif;font-variant-numeric:tabular-nums}.stat span{font-weight:600}
.flow{font:14px/1.6 ui-monospace,monospace;color:var(--muted);overflow-wrap:anywhere}
article{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--line);padding:24px;margin:16px 0}article.verified{border-left-color:var(--ok)}article.rejected{border-left-color:var(--no)}
.head{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}.tag{font:12px/1 ui-monospace,monospace;text-transform:uppercase;padding:4px 8px;border:1px solid currentColor}.tag.verified{color:var(--ok)}.tag.rejected{color:var(--no)}
.rule{color:var(--muted);margin:8px 0;overflow-wrap:anywhere}.marks{list-style:none;padding:0;margin:8px 0;display:flex;flex-wrap:wrap;gap:8px 24px}.marks .ok{color:var(--ok)}.marks .no{color:var(--no)}.marks .na{color:var(--muted)}.reason{color:var(--no);font-weight:600}
dl{margin:16px 0}dl div{display:grid;grid-template-columns:120px 1fr;gap:16px;padding:8px 0;border-top:1px solid var(--line)}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 ui-monospace,monospace;background:var(--code);padding:16px;margin:0}.diff span{display:block;min-height:1.6em}.diff .add{background:var(--add)}.diff .del{background:var(--del)}.diff .meta,.diff .hunk{color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}td code{overflow-wrap:anywhere}.o-verified{color:var(--ok)}.o-rejected{color:var(--no)}
@media (max-width:640px){dl div{grid-template-columns:1fr;gap:0}table,thead,tbody,tr,th,td{display:block}thead{display:none}td{border:0;padding:2px 0}tr{border-bottom:1px solid var(--line);padding:8px 0}h1{font-size:32px}}
</style></head><body><main>
<header><small>TOKENPILOT / TRUST REPORT</small><h1>${escape(run.project)}</h1><p class="muted">${escape(new Date(run.started).toISOString().slice(0, 16).replace("T", " "))} UTC · commit ${escape(String(run.commit).slice(0, 7))} · run ${escape(run.id)}<br>Every number below comes from this run. Repairs ran on a private clone; your repository was not modified.</p></header>
<section class="stats">
${stat(0, "model tokens to find", `${run.findings.length} finding${run.findings.length === 1 ? "" : "s"} from ${run.scanners.map((s) => s.tool).join(" + ")} across ${run.files} files`)}
${stat(run.groups, "repair briefs", `built locally from ${run.findings.length} findings, grouped by rule and file`)}
${stat(`${pct(verified.length, run.attempted)}%`, "of patches verified", `${verified.length} of ${run.attempted}: checks pass, finding gone, nothing new`)}
${stat(`${pct(rejected.length, run.attempted)}%`, "rejected by the gate", `${rejected.length} attempt${rejected.length === 1 ? "" : "s"} reverted before a person had to look`)}
</section>
<p class="flow">Scan (0 tokens) → Brief (0 tokens) → Claude repair (${num(totalTokens)} tokens, ${usd(totalCost)} total${perFix ? `, ${num(perFix)} per verified fix` : ""}) → Gate → keep or revert</p>
<p class="muted">Repair limits: ${escape(run.limits.model)}, ${escape(run.limits.effort)} effort, $${escape(run.limits.spendPerRepair)} cap per repair${run.groups > run.attempted ? `, first ${run.attempted} of ${run.groups} groups attempted` : ""}. Costs are Claude Code CLI estimates, not an invoice.</p>
<h2>Verified patches · ${verified.length}</h2>
${verified.map(repairCard).join("") || '<p class="muted">No patch passed every gate in this run.</p>'}
<h2>Stopped by the gate · ${rejected.length}</h2>
${rejected.map(repairCard).join("") || '<p class="muted">No attempt was rejected.</p>'}
<h2>Every finding · ${run.findings.length}</h2>
<table><thead><tr><th>Severity</th><th>Location</th><th>Scanner · rule</th><th>Outcome</th></tr></thead><tbody>
${run.findings
  .map((f) => {
    const o = outcome.get(`${f.tool}:${f.rule}:${f.file}`) || "not attempted";
    return `<tr><td>${escape(sev(f.severity))}</td><td><code>${escape(f.file)}:${f.line}</code></td><td>${escape(f.tool)} · ${escape(f.rule)}<br><small>${escape(f.message)}</small></td><td class="o-${o === "not attempted" ? "na" : o}">${escape(o)}</td></tr>`;
  })
  .join("")}
</tbody></table>
<h2>What verified means here</h2>
<p>A patch is verified when the project's required checks pass, the selected finding no longer matches on rescan, no new finding or suppression pattern appears, and existing tests and check configuration are unchanged. It does not mean an exploit was reproduced or that behavior is proven safe. No independent AI reviewer was used. Scanners ran the bundled starter rule pack, not a full audit.</p>
<small>Generated by TokenPilot. Offline HTML: no scripts, external assets or tracking. Review diffs before sharing; redaction cannot recognize every secret.</small>
</main></body></html>`;
}

module.exports = { trustReport };
