const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { hash } = require("./policy.cjs");
const excluded = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".venv",
  "__pycache__",
  ".DS_Store",
]);
function safe(root, relative, write = false) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative))
    throw Error("Use a project-relative path.");
  const p = path.resolve(root, relative);
  if (!p.startsWith(root + path.sep)) throw Error("Path leaves project.");
  const parts = path.relative(root, p).split(path.sep);
  if (
    parts.some(
      (x) =>
        excluded.has(x) ||
        x === ".claude" ||
        x === ".tokenpilot" ||
        x === ".env" ||
        x.startsWith(".env."),
    ) ||
    parts.includes(".mcp.json")
  )
    throw Error("Protected or generated path.");
  let cur = root;
  for (const part of parts) {
    cur = path.join(cur, part);
    if (fs.existsSync(cur) && fs.lstatSync(cur).isSymbolicLink())
      throw Error("Symlink paths are not permitted.");
  }
  return p;
}
function list(root, all = false) {
  let out = [];
  function walk(dir) {
    for (const e of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === ".git" || (!all && excluded.has(e.name))) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isSymbolicLink() && all)
        throw Error(
          "Cache disabled: symlink dependency inputs are not closed.",
        );
      else if (e.isFile()) out.push(path.relative(root, p));
      if (out.length > 150000)
        throw Error("Project too large to fingerprint safely.");
    }
  }
  walk(root);
  return out;
}
function fingerprint(root, all = false) {
  const crypto = require("node:crypto");
  const h = crypto.createHash("sha256");
  for (const f of list(root, all)) {
    h.update(f + "\0" + fs.statSync(path.join(root, f)).mode + "\0");
    h.update(fs.readFileSync(path.join(root, f)));
  }
  return h.digest("hex");
}
function git(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 20 * 1024 * 1024,
      timeout: 10000,
    });
  } catch {
    return "";
  }
}
function changes(root) {
  const status = git(root, ["status", "--short"]);
  let diff = git(root, ["diff", "HEAD", "--no-ext-diff", "--no-textconv"]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"])
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const f of untracked.slice(0, 30)) {
    try {
      const p = safe(root, f);
      if (fs.statSync(p).size > 128000) {
        diff += `\nNew file ${f}: too large for inline diff.\n`;
        continue;
      }
      const text = fs.readFileSync(p, "utf8");
      if (text.includes("\0")) continue;
      const lines = text.split("\n");
      diff +=
        `\ndiff --git a/${f} b/${f}\nnew file\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,${lines.length} @@\n` +
        lines.map((x) => "+" + x).join("\n") +
        "\n";
    } catch {}
  }
  return { status, diff, untracked };
}
function readConfig(root) {
  const p = path.join(root, "tokenpilot.json");
  if (!fs.existsSync(p)) return { rules: "", checks: [] };
  const c = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!Array.isArray(c.checks || []))
    throw Error("tokenpilot.json checks must be an array");
  for (const ch of c.checks || [])
    if (
      !ch.id ||
      !Array.isArray(ch.command) ||
      !ch.command.length ||
      !ch.command.every((x) => typeof x === "string")
    )
      throw Error("Each check needs an id and command array");
  return {
    rules: c.rules || "",
    checks: c.checks || [],
    proof: c.proof || null,
  };
}
function detectChecks(root) {
  let checks = [];
  try {
    const p = JSON.parse(fs.readFileSync(path.join(root, "package.json")));
    for (const name of ["test", "lint", "typecheck", "build"])
      if (p.scripts?.[name] && !/no test specified/.test(p.scripts[name]))
        checks.push({
          id: name,
          command: ["npm", "run", name],
          required: true,
          cacheable: false,
        });
  } catch {}
  if (fs.existsSync(path.join(root, "pytest.ini")))
    checks.push({
      id: "pytest",
      command: ["python3", "-m", "pytest"],
      required: true,
      cacheable: false,
    });
  return checks;
}
module.exports = {
  safe,
  list,
  fingerprint,
  git,
  changes,
  readConfig,
  detectChecks,
};
