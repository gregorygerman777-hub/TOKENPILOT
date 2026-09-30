const $ = (id) => document.getElementById(id);
let token = "",
  history = [],
  selected = null,
  busy = false,
  pollTimer = null;
const buttons = [...document.querySelectorAll("[data-download]")];
function error(message) {
  $("error").textContent = message || "";
  $("error").hidden = !message;
}
async function api(route, body) {
  const response = await fetch("/api/" + route, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer " + token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "Request failed");
  return data;
}
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function render() {
  const r = history.find((r) => r.id === selected);
  $("scan").disabled = busy;
  $("sample").disabled = busy;
  $("choose-files").disabled = busy;
  $("choose-folder").disabled = busy;
  $("stop").disabled = !busy;
  $("compare").disabled =
    busy ||
    !r ||
    !["completed", "scanner-cleared", "verified", "rejected"].includes(
      r.status,
    );
  $("actions").hidden = !r;
  $("summary").hidden = !r;
  buttons.forEach((b) => (b.disabled = busy || !r || r.status === "scanning"));
  $("history").replaceChildren();
  if (!history.length) $("history").append(el("p", "No scans yet.", "hint"));
  for (const record of history) {
    const button = el("button", undefined, "history-item");
    button.setAttribute("aria-pressed", String(record.id === selected));
    button.append(
      el("span", record.root.split("/").pop()),
      el("span", new Date(record.started).toLocaleString()),
      el("span", record.status + " / " + record.findings.length + " findings"),
    );
    button.addEventListener("click", () => {
      selected = record.id;
      $("root").value = record.root;
      render();
    });
    $("history").append(button);
  }
  if (!r) return;
  $("result-title").textContent = r.root.split("/").pop();
  $("status").textContent = r.status;
  $("summary").replaceChildren(
    el("strong", String(r.findings.length) + " static findings"),
    el("p", r.groups.length + " candidate groups / 0 model tokens"),
    el(
      "p",
      (r.snapshot?.manifest?.length || 0) +
        " files captured / " +
        (r.snapshot?.excluded?.length || 0) +
        " explicit exclusions",
    ),
  );
  $("summary").append(
    el("p", "Tokens saved: not measured. A matched comparison is required."),
  );
  if (r.comparison)
    $("summary").append(
      el(
        "p",
        r.comparison.cleared.length +
          " groups cleared / " +
          r.comparison.remaining.length +
          " findings remain / " +
          r.comparison.introduced.length +
          " introduced",
      ),
    );
  if (r.error) $("summary").append(el("p", r.error));
  for (const scanner of r.scanners)
    $("summary").append(el("p", scanner.tool + ": " + scanner.status));
  $("findings").replaceChildren();
  for (const group of r.groups) {
    const card = el("article", undefined, "finding");
    card.append(
      el("span", group.tool + " / STATIC FINDING", "label"),
      el("h3", group.rule),
      el(
        "code",
        group.file + ": " + group.findings.map((f) => f.line).join(", "),
      ),
      el("p", group.findings[0]?.message || "Review this finding."),
    );
    $("findings").append(card);
  }
  if (!r.groups.length)
    $("findings").append(
      el(
        "p",
        r.status === "completed" || r.status === "scanner-cleared"
          ? "No findings from the configured rules. This is not a comprehensive security audit."
          : "No findings to display. Check scan status and coverage.",
        "hint",
      ),
    );
}
async function refresh() {
  try {
    const state = await api("status");
    history = state.history;
    busy = !!state.active;
    if (state.active?.id) selected = state.active.id;
    if (!selected && history.length) {
      selected = history[0].id;
      $("root").value = history[0].root;
    }
    $("connection").textContent = "Connected to this Mac";
    $("progress").textContent = state.active
      ? "Scanning " +
        state.active.root +
        " / " +
        (state.active.scanners?.length || 0) +
        " of 2 scanners finished"
      : "";
    render();
    return state;
  } catch (e) {
    $("connection").textContent = "Local server disconnected";
    error(e.message + " Start npm run web and reload.");
  }
}
async function scan(baseline) {
  error("");
  try {
    if (!$("root").value.trim())
      throw Error("Enter a project folder or choose Use sample project.");
    await api("scans", {
      root: $("root").value.trim(),
      ...(baseline ? { baseline } : {}),
    });
    await refresh();
  } catch (e) {
    error(e.message);
  }
}
$("scan").addEventListener("click", () => scan());
$("root").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !busy) scan();
});
$("compare").addEventListener("click", () => scan(selected));
$("stop").addEventListener("click", async () => {
  try {
    await api("stop", {});
    await refresh();
  } catch (e) {
    error(e.message);
  }
});
$("sample").addEventListener("click", async () => {
  try {
    const data = await api("sample", {});
    $("root").value = data.root;
    await scan();
  } catch (e) {
    error(e.message);
  }
});
$("refresh").addEventListener("click", () => refresh());
buttons.forEach((button) =>
  button.addEventListener("click", async () => {
    try {
      const response = await fetch(
        "/api/scans/" + selected + "/" + button.dataset.download,
        { headers: { Authorization: "Bearer " + token } },
      );
      if (!response.ok) throw Error("Could not download evidence.");
      const blob = await response.blob(),
        url = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = url;
      a.download =
        "tokenpilot-" +
        selected +
        "." +
        { report: "html", sarif: "sarif", json: "json" }[
          button.dataset.download
        ];
      a.click();
      requestAnimationFrame(() => URL.revokeObjectURL(url));
    } catch (e) {
      error(e.message);
    }
  }),
);
async function poll() {
  await refresh();
  pollTimer = setTimeout(poll, busy ? 1000 : 5000);
}
(async () => {
  try {
    const response = await fetch("/api/session");
    if (!response.ok) throw Error("Could not connect to TokenPilot.");
    const session = await response.json();
    token = session.token;
    $("version").textContent = "/ " + session.version;
    await poll();
    const capabilities = await api("capabilities");
    $("capabilities").replaceChildren(
      ...Object.entries(capabilities).map(([name, value]) =>
        el(
          "span",
          name + ": " + (value.available ? "available" : "not installed"),
        ),
      ),
    );
  } catch (e) {
    error(e.message);
  }
})();
window.addEventListener("pagehide", () => clearTimeout(pollTimer));

$("choose-files").addEventListener("click", () => $("files").click());
$("choose-folder").addEventListener("click", () => $("folder").click());
async function chooseFiles(input) {
  const files = [...input.files];
  if (!files.length) return;
  error("");
  try {
    if (
      files.length > 256 ||
      files.reduce((sum, f) => sum + f.size, 0) > 16 * 1024 * 1024 ||
      files.some((f) => f.size > 4 * 1024 * 1024)
    )
      throw Error(
        "Choose up to 256 files, under 4 MB each and 16 MB total. For larger projects paste the folder path.",
      );
    $("progress").textContent = "Reading selected files on this Mac...";
    const encoded = await Promise.all(
      files.map(
        (file) =>
          new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () =>
              resolve({
                name: file.webkitRelativePath || file.name,
                data: String(reader.result).split(",")[1],
              });
            reader.onerror = () => reject(Error("Could not read " + file.name));
            reader.readAsDataURL(file);
          }),
      ),
    );
    const result = await api("uploads", { files: encoded });
    $("root").value = result.root;
    await scan();
  } catch (e) {
    error(e.message);
  } finally {
    input.value = "";
  }
}
$("files").addEventListener("change", () => chooseFiles($("files")));
$("folder").addEventListener("change", () => chooseFiles($("folder")));
