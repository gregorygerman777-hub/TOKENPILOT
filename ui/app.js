const $ = (id) => document.getElementById(id);
let root = "",
  mode = "economy",
  tab = "activity",
  current = null,
  history = [],
  busy = false,
  approvalId = null,
  audit = null,
  auditBaseline = null,
  auditGroups = [],
  auditHistory = [];
const auditEmpty = $("scanSummary").innerHTML;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function error(e) {
  $("error").textContent = e.message || e;
  $("error").hidden = false;
}
async function call(name, arg) {
  $("error").hidden = true;
  try {
    return await window.pilot.call(name, arg);
  } catch (e) {
    error(e);
    throw e;
  }
}
function project(p) {
  if (root !== p) {
    audit = null;
    auditBaseline = null;
    auditGroups = [];
    $("securityScope").hidden = true;
  }
  root = p;
  $("projectPath").textContent = p || "Choose a folder to begin.";
  $("choose").firstChild.textContent = p
    ? p.split("/").pop() + " "
    : "Select project ";
}
function page(name) {
  document.querySelectorAll(".page").forEach((e) => (e.hidden = e.id !== name));
  document
    .querySelectorAll(".nav")
    .forEach((e) => e.classList.toggle("active", e.dataset.page === name));
  if (name === "history") renderHistory();
  if (name === "security") loadSecurity();
  if (name === "settings" && root) loadConfig();
}
function connection(c) {
  $("connectionLabel").textContent = c.loggedIn
    ? "Claude Code connected"
    : "Claude Code needs attention";
  $("connectionDetail").textContent = c.loggedIn
    ? `${c.version} · Signed in via ${c.authMethod}`
    : c.error || "Sign in to Claude Code to start a task.";
  $("capabilities").innerHTML = [
    ["File tools, edits, verification", "Supported"],
    ["Stop and resume", "Supported; resume starts a new run budget"],
    ["Token threshold", "Best effort, delayed accounting"],
    ["Spend ceiling", "Provider request boundary; may overshoot"],
    ["Time / tool / repeat limits", "Enforced locally"],
    ["Subscription allowance", "Unavailable"],
    ["Reasoning tokens", "Shown only when reported"],
  ]
    .map(
      ([a, b]) =>
        `<div class="data-row"><span>${a}</span><span>${b}</span></div>`,
    )
    .join("");
}
function setBusy(v) {
  busy = v;
  $("run").disabled = v;
  $("stop").disabled = !v;
  $("choose").disabled = v;
  $("recent").disabled = v;
}
function render() {
  if (!current) return;
  const r = current;
  $("taskStatus").textContent = r.status.replaceAll("_", " ");
  $("logs").disabled = false;
  $("taskReport").disabled = false;
  $("recovery").hidden = busy || !r.sessionId;
  $("resume").disabled = busy || !r.sessionId;
  $("escalate").hidden = !r.escalation?.permitted;
  const box = $("runContent");
  if (tab === "activity") {
    box.innerHTML =
      r.events
        .filter((e) => !["verification", "result"].includes(e.type))
        .map((e) => {
          let title = e.type,
            detail = "";
          if (e.type === "activity") {
            title =
              {
                read: "Read relevant code",
                search: "Find a specific reference",
                discover: "Find project files",
                edit: "Apply a focused edit",
                write: "Create a file",
                verify: "Check the result",
                finish: "Review acceptance",
                command: "Request a local command",
                escalate: "Review escalation",
              }[e.data.name] || e.data.name;
            detail =
              e.data.args.path || e.data.args.text || e.data.args.reason || "";
          } else
            detail =
              typeof e.data === "string"
                ? e.data
                : e.data.message || e.data.summary || "";
          return `<div class="event"><time>${new Date(e.time).toLocaleTimeString()}</time><b>${esc(title)}</b><p>${esc(detail)}</p></div>`;
        })
        .join("") +
      (r.result
        ? `<div class="panel"><h2>Result</h2><p>${esc(r.result)}</p>${r.acceptance.map((a) => `<div class="data-row"><b>${esc(a.criterion)}</b><span>${esc(a.evidence)}</span></div>`).join("")}</div>`
        : "");
    if (r.stopReason)
      box.innerHTML += `<p class="note">${esc(r.stopReason)}</p>`;
  }
  if (tab === "changes") {
    box.innerHTML =
      '<p class="note">Current working tree compared with HEAD. Includes changes that existed before this task. New files are listed below.</p><pre>' +
      esc(r.changes?.status || "No Git changes reported.") +
      "</pre><pre>" +
      esc(
        r.changes?.diff ||
          "No tracked diff available. A Git repository is required for tracked diffs.",
      ) +
      "</pre>" +
      (r.changes?.untracked || [])
        .map(
          (f) =>
            `<div class="data-row"><span>New file</span><code>${esc(f)}</code></div>`,
        )
        .join("");
  }
  if (tab === "verification") {
    box.innerHTML = r.checks.length
      ? r.checks
          .map(
            (c) =>
              `<div class="event"><b>${esc(c.id)} <span class="${esc(c.status)}">${esc(c.status)}</span></b><p>${esc(c.reason || "Waiting to run")}</p><code>${esc(c.command.join(" "))}</code>${c.output ? `<details><summary>Check output</summary><pre>${esc(c.output)}</pre></details>` : ""}</div>`,
          )
          .join("")
      : "<p>No checks configured or detected. Add required checks in Project rules. Acceptance claims alone do not independently prove correctness.</p>";
  }
  if (tab === "usage") {
    const u = r.usage || r.partialUsage;
    const fmt = (n) =>
      n === undefined || n === null
        ? "Not reported"
        : Number(n).toLocaleString();
    box.innerHTML =
      `<p class="note">${esc(r.accounting || "Usage arrives after model responses. In-flight work may not appear yet.")}</p>` +
      [
        ["Uncached input", u?.input_tokens],
        ["Cache writes", u?.cache_creation_input_tokens],
        ["Cache reads", u?.cache_read_input_tokens],
        ["Output", u?.output_tokens],
        [
          "Reasoning (subset of output)",
          u?.output_tokens_details?.thinking_tokens,
        ],
        ["Tool calls", r.metrics.toolCalls],
        ["Duplicate reads avoided", r.metrics.duplicateReads],
        ["Blocked actions", r.metrics.blockedActions],
        ["Provider retries", r.metrics.retries],
      ]
        .map(
          ([k, v]) =>
            `<div class="data-row"><span>${k}</span><code>${fmt(v)}</code></div>`,
        )
        .join("") +
      `<div class="data-row"><span>Reported API-price estimate</span><code>${r.reportedCost == null ? "Not reported" : "$" + r.reportedCost.toFixed(5)}</code></div><div class="data-row"><span>Model / effort</span><code>${esc(r.model)} / ${esc(r.effort)}</code></div><div class="data-row"><span>Elapsed</span><code>${Math.round((r.elapsedMs || Date.now() - r.started) / 1000)} s</code></div><p class="note">Cache reads, shorter logs, and blocked actions are supporting indicators, not measured token savings. Provider cost estimates do not measure subscription usage. TokenPilot uses no supervisor model.</p>`;
  }
}
function renderHistory() {
  $("historyList").innerHTML = history.length
    ? history
        .map(
          (r) =>
            `<button class="history-item" data-id="${r.id}"><div><b>${esc(r.task)}</b><br><span>${esc(r.root)} · ${new Date(r.started).toLocaleString()}</span></div><span>${esc(r.status)}</span></button>`,
        )
        .join("")
    : '<p class="muted">Your completed and interrupted tasks will appear here.</p>';
  document.querySelectorAll(".history-item").forEach(
    (b) =>
      (b.onclick = () => {
        current = history.find((r) => r.id === b.dataset.id);
        project(current.root);
        page("workspace");
        render();
      }),
  );
}
async function loadConfig() {
  const c = await call("config", root);
  $("config").value = JSON.stringify(
    {
      rules: c.rules,
      checks: c.checks.length ? c.checks : c.detected,
      ...(c.proof ? { proof: c.proof } : {}),
    },
    null,
    2,
  );
}
$("choose").onclick = async () => {
  const p = await call("choose");
  if (p) {
    project(p);
    const o = document.createElement("option");
    o.value = p;
    o.textContent = p.split("/").pop();
    $("recent").append(o);
    $("recent").value = p;
  }
};
$("recent").onchange = (e) => project(e.target.value);
document
  .querySelectorAll(".nav")
  .forEach((b) => (b.onclick = () => page(b.dataset.page)));
document.querySelectorAll(".mode").forEach(
  (b) =>
    (b.onclick = () => {
      mode = b.dataset.mode;
      document
        .querySelectorAll(".mode")
        .forEach((x) => x.classList.toggle("selected", x === b));
      $("minutes").value = { economy: 10, balanced: 20, deep: 45 }[mode];
      $("repeats").value = { economy: 2, balanced: 3, deep: 4 }[mode];
    }),
);
document.querySelectorAll(".tab").forEach(
  (b) =>
    (b.onclick = () => {
      tab = b.dataset.tab;
      document
        .querySelectorAll(".tab")
        .forEach((x) => x.classList.toggle("active", x === b));
      render();
    }),
);
$("composer").onsubmit = async (e) => {
  e.preventDefault();
  if (!root) return error("Select a project first.");
  setBusy(true);
  try {
    current = await call("start", {
      root,
      auditId: auditBaseline,
      auditGroups,
      task: $("task").value,
      criteria: $("criteria").value,
      mode,
      model: $("model").value,
      spend: +$("spend").value,
      minutes: +$("minutes").value,
      tokens: +$("tokens").value,
      repeats: +$("repeats").value,
      optionalChecks: +$("optionalChecks").value,
      autoEscalate: $("autoEscalate").checked,
    });
    render();
  } catch {
    setBusy(false);
  }
};
$("stop").onclick = () => call("stop");
$("logs").onclick = () => call("logs", current.id);
$("saveConfig").onclick = async () => {
  if (!root) return error("Choose a project first.");
  await call("saveConfig", { root, text: $("config").value });
  $("saveConfig").textContent = "Saved";
  setTimeout(() => ($("saveConfig").textContent = "Save project rules"), 1800);
};
$("login").onclick = () => call("login");
$("refresh").onclick = async () => connection(await call("connect"));
for (const [id, escalate] of [
  ["resume", false],
  ["escalate", true],
])
  $(id).onclick = async () => {
    setBusy(true);
    try {
      current = await call("resume", { id: current.id, escalate });
      render();
    } catch {
      setBusy(false);
    }
  };
window.pilot.on("task", (r) => {
  current = r;
  history = [r, ...history.filter((x) => x.id !== r.id)];
  render();
});
window.pilot.on("idle", () => {
  if ($("approval").open) $("approval").close("deny");
  setBusy(false);
  render();
});
window.pilot.on("approval", (a) => {
  approvalId = a.id;
  $("approvalTitle").textContent =
    a.kind === "escalation" ? "Use more reasoning?" : "Run this command?";
  $("approvalReason").textContent = a.reason;
  $("approvalCommand").textContent = a.command
    ? JSON.stringify(a.command, null, 2)
    : "Prepare a fresh session with higher effort within the remaining reported budget.";
  $("approval").returnValue = "deny";
  $("approval").showModal();
});
$("approval").addEventListener("close", () =>
  call("answer", {
    id: approvalId,
    allow: $("approval").returnValue === "allow",
  }),
);
(async () => {
  try {
    const data = await call("init");
    history = data.history;
    connection(data.connection);
    for (const p of data.recent) {
      const o = document.createElement("option");
      o.value = p;
      o.textContent = p.split("/").pop();
      $("recent").append(o);
    }
    if (data.recent[0]) {
      project(data.recent[0]);
      $("recent").value = root;
    }
    if (data.active) {
      current = data.active;
      setBusy(true);
      render();
    }
  } catch {}
})();

async function loadSecurity() {
  const data = await call("security");
  auditHistory = data.history;
  $("scannerStatus").innerHTML = Object.entries(data.capabilities)
    .map(
      ([name, c]) =>
        `<div><span class="${c.available ? "passed" : "unrun"}">${c.available ? "●" : "○"}</span> <b>${esc(name)}</b> <small>${esc(c.available ? c.version : c.reason)}</small></div>`,
    )
    .join("");
  renderAudit();
}
function scanBusy(value) {
  $("scan").disabled = value || busy;
  $("scanStop").disabled = !value;
  $("rescan").disabled = value || !audit;
  $("auditReport").disabled = value || !audit;
  $("choose").disabled = value || busy;
  $("recent").disabled = value || busy;
}
function renderAudit() {
  const history = auditHistory.filter((r) => r.root === root);
  $("auditHistory").innerHTML =
    history
      .map(
        (r) =>
          `<button class="history-item" data-audit="${r.id}"><span>${new Date(r.started).toLocaleString()}</span><b>${esc(r.status)}</b></button>`,
      )
      .join("") || '<p class="note">No scans for this project yet.</p>';
  document.querySelectorAll("[data-audit]").forEach(
    (b) =>
      (b.onclick = () => {
        audit = auditHistory.find((r) => r.id === b.dataset.audit);
        renderAudit();
      }),
  );
  if (!audit) {
    $("scanSummary").innerHTML = auditEmpty;
    $("scanStatus").textContent = "Ready";
    $("rescan").disabled = true;
    $("auditReport").disabled = true;
    $("findings").innerHTML = "";
    return;
  }
  $("scanStatus").textContent = audit.status;
  $("rescan").disabled = !!busy;
  $("auditReport").disabled = false;
  const c = audit.comparison;
  $("scanSummary").innerHTML =
    `<div class="scan-count"><strong>${audit.findings.length}</strong><div>static findings<br><span>${audit.groups.length} candidate groups · 0 model tokens</span></div></div><p class="note">${audit.snapshot?.manifest.length || 0} files captured. Snapshot ${esc(audit.snapshot?.hash.slice(0, 12) || "pending")}. ${audit.snapshot?.excluded.length || 0} additional exclusions. Generated directories excluded.</p>${c ? `<div class="gate-strip"><span>${c.cleared.length} groups cleared</span><span>${c.remaining.length} findings remain</span><span>${c.introduced.length} new findings</span></div>` : ""}${audit.scanners.map((s) => `<div class="data-row"><span>${esc(s.tool)}</span><b class="${s.status === "completed" ? "passed" : "failed"}">${esc(s.status)}</b></div>`).join("")}<p class="note">Behavioral probe: ${esc(audit.proof.status)}. ${esc(audit.error || "Static evidence does not demonstrate exploitability.")}</p>`;
  $("findings").innerHTML =
    audit.groups
      .map(
        (g) =>
          `<article class="finding"><div class="finding-head"><span class="eyebrow">${esc(g.tool)} / STATIC FINDING</span><span>${g.findings.length} location${g.findings.length === 1 ? "" : "s"}</span></div><h2>${esc(g.rule)}</h2><code>${esc(g.file)}:${g.findings.map((f) => f.line).join(", ")}</code><p>${esc(g.findings[0].message)}</p><button class="btn" data-repair="${g.id}">Prepare focused repair ↗</button></article>`,
      )
      .join("") ||
    '<div class="panel"><h2>No findings returned.</h2><p>Check scanner coverage above. An empty result is not a security guarantee.</p></div>';
  document.querySelectorAll("[data-repair]").forEach(
    (b) =>
      (b.onclick = async () => {
        const g = audit.groups.find((g) => g.id === b.dataset.repair);
        const brief = await call("brief", { id: audit.id, groupId: g.id });
        auditBaseline = audit.id;
        auditGroups = [g.id];
        $("securityScope").hidden = false;
        $("task").value =
          `Review and fix ${g.rule} in ${g.file}. Preserve intended behavior. Do not hide findings or modify scanner configuration. Report false positives honestly. The selected group must clear without introducing new findings. Required project checks must pass.\n\n${brief.text}`;
        $("criteria").value =
          `The unsafe behavior in ${g.file} is resolved without suppressing scanner rules
Required project checks pass`;
        page("workspace");
        $("task").focus();
      }),
  );
}
async function doScan(baseline) {
  if (!root) return error("Select a project first.");
  scanBusy(true);
  try {
    audit = await call("scan", { root, baseline });
    auditHistory = [audit, ...auditHistory.filter((r) => r.id !== audit.id)];
    renderAudit();
  } finally {
    scanBusy(false);
  }
}
$("scan").onclick = () => doScan(null);
$("rescan").onclick = () => doScan(audit.baseline || audit.id);
$("scanStop").onclick = () => call("scanStop");
$("auditReport").onclick = async () => {
  const result = await call("exportReport", { id: audit.id, kind: "audit" });
  if (result) $("scanStatus").textContent = "Report saved";
};
$("taskReport").onclick = () =>
  call("exportReport", { id: current.id, kind: "task" });
window.pilot.on("audit", (r) => {
  audit = r;
  auditHistory = [r, ...auditHistory.filter((x) => x.id !== r.id)];
  renderAudit();
  scanBusy(r.status === "scanning");
});

$("demo").onclick = async () => {
  project(await call("demo"));
  await doScan(null);
};
$("clearScope").onclick = () => {
  auditBaseline = null;
  auditGroups = [];
  $("securityScope").hidden = true;
};

$("web").onclick = () => call("web");
