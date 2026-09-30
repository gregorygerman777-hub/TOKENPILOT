const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { group, compare, redact } = require("./security.cjs");
const { report } = require("./report.cjs");
const digest = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
const SCHEMA = "tokenpilot.evidence/v1";
const relative = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  !path.posix.isAbsolute(value) &&
  !path.win32.isAbsolute(value) &&
  !value.split(/[\\/]/).includes("..");
function portable(record) {
  const findings = record.findings.map((f) => ({
    id: f.id,
    tool: f.tool,
    rule: f.rule,
    file: f.file,
    line: f.line,
    severity: f.severity || "WARNING",
    message: redact(f.message),
    evidence: "static-finding",
  }));
  const result = {
    schema: SCHEMA,
    id: record.id,
    started: record.started,
    ended: record.ended,
    status: record.status,
    modelTokens: 0,
    rulesHash: record.rulesHash,
    snapshot: record.snapshot,
    scanners: record.scanners.map((s) => ({
      tool: s.tool,
      version: s.version,
      status: s.status,
    })),
    findings,
    groups: group(findings),
    proof: { status: record.proof?.status || "not-configured" },
    limitations: [
      "Static evidence only; no claim of exploit reproduction.",
      "Generated directories, symlinks and files larger than 4 MB are outside coverage.",
      "File paths and finding messages may contain sensitive information. Review before sharing.",
    ],
  };
  if (record.comparison)
    result.comparison = {
      status: record.comparison.status,
      complete: record.comparison.complete,
      cleared: record.comparison.cleared.map((g) => ({
        tool: g.tool,
        rule: g.rule,
        file: g.file,
      })),
      remaining: record.comparison.remaining.map((f) => ({
        tool: f.tool,
        rule: f.rule,
        file: f.file,
        line: f.line,
      })),
      introduced: record.comparison.introduced.map((f) => ({
        tool: f.tool,
        rule: f.rule,
        file: f.file,
        line: f.line,
      })),
    };
  if (record.error) result.error = redact(record.error);
  return result;
}
function validate(value) {
  if (
    value?.schema !== SCHEMA ||
    !Array.isArray(value.findings) ||
    !Array.isArray(value.scanners) ||
    !Array.isArray(value.snapshot?.manifest) ||
    !Array.isArray(value.snapshot?.excluded) ||
    typeof value.rulesHash !== "string" ||
    !value.rulesHash
  )
    throw Error("Invalid TokenPilot baseline evidence");
  if (
    value.scanners.length !== 2 ||
    new Set(value.scanners.map((s) => s.tool)).size !== 2 ||
    !["semgrep", "gitleaks"].every((tool) =>
      value.scanners.some(
        (s) =>
          s.tool === tool &&
          typeof s.version === "string" &&
          s.version.length &&
          s.status === "completed",
      ),
    )
  )
    throw Error("Baseline requires complete Semgrep and Gitleaks scans");
  if (!["completed", "scanner-cleared", "verified"].includes(value.status))
    throw Error("Baseline scan did not complete");
  for (const f of value.findings)
    if (
      !relative(f.file) ||
      !["semgrep", "gitleaks"].includes(f.tool) ||
      typeof f.rule !== "string" ||
      !f.rule ||
      !Number.isInteger(f.line) ||
      f.line < 0
    )
      throw Error("Invalid finding in baseline");
  for (const f of value.snapshot.manifest)
    if (!relative(f.path) || typeof f.hash !== "string")
      throw Error("Invalid source manifest");
  if (!value.snapshot.manifest.length)
    throw Error("Baseline contains no covered source");
  return { ...value, groups: group(value.findings) };
}
function ciGate(current, baseline) {
  const complete =
    ["completed", "scanner-cleared", "verified"].includes(current.status) &&
    current.scanners.length === 2 &&
    ["semgrep", "gitleaks"].every((t) =>
      current.scanners.some((s) => s.tool === t && s.status === "completed"),
    );
  if (!complete)
    return {
      status: "incomplete",
      exitCode: 2,
      reason: "All required scanners must complete.",
      introduced: [],
      existing: [],
      cleared: [],
    };
  if (!baseline)
    return {
      status: current.findings.length ? "findings" : "clean",
      exitCode: current.findings.length ? 1 : 0,
      reason: "No baseline: all findings block CI.",
      introduced: current.findings,
      existing: [],
      cleared: [],
    };
  const before = validate(baseline),
    comparison = compare(before, current);
  if (!comparison.complete)
    return {
      status: "incomplete",
      exitCode: 2,
      reason:
        "Scanner versions, rules or exclusions differ from the baseline. Review and regenerate it.",
      introduced: [],
      existing: [],
      cleared: [],
    };
  return {
    status: comparison.introduced.length ? "regression" : "no-new-findings",
    exitCode: comparison.introduced.length ? 1 : 0,
    reason:
      "Baseline mode blocks new rule/file groups and count increases. Existing findings remain visible; this is not a repair-verification gate.",
    introduced: comparison.introduced,
    existing: comparison.remaining,
    cleared: comparison.cleared,
  };
}
function sarif(record, gate) {
  const rules = [...new Set(record.findings.map((f) => f.tool + "/" + f.rule))];
  const introduced = new Set((gate?.introduced || []).map((f) => f.id));
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "TokenPilot",
            version: require("../package.json").version,
            informationUri:
              "https://tokenpilot-lab.gregorygerman777.chatgpt.site",
            rules: rules.map((id) => ({
              id,
              shortDescription: { text: id.split("/").pop() },
            })),
          },
        },
        invocations: [
          {
            executionSuccessful:
              record.scanners.length === 2 &&
              record.scanners.every((s) => s.status === "completed"),
            toolExecutionNotifications: record.scanners
              .filter((s) => s.status !== "completed")
              .map((s) => ({
                level: "error",
                message: { text: s.tool + ": " + s.status },
              })),
          },
        ],
        results: record.findings.map((f) => ({
          ruleId: f.tool + "/" + f.rule,
          level: /ERROR|HIGH|CRITICAL/i.test(f.severity || "")
            ? "error"
            : "warning",
          message: { text: redact(f.message || f.rule) },
          locations: [
            {
              physicalLocation: {
                artifactLocation: {
                  uri: f.file.split("/").map(encodeURIComponent).join("/"),
                  uriBaseId: "%SRCROOT%",
                },
                ...(f.line > 0 ? { region: { startLine: f.line } } : {}),
              },
            },
          ],
          partialFingerprints: {
            "tokenpilotGroup/v1": digest(
              JSON.stringify([f.tool, f.rule, f.file]),
            ),
          },
          ...(gate && gate.status !== "incomplete"
            ? { baselineState: introduced.has(f.id) ? "new" : "unchanged" }
            : {}),
        })),
        properties: { evidence: "static-scanner-output", modelTokens: 0 },
      },
    ],
  };
}
function markdown(record, gate) {
  return (
    "# TokenPilot evidence\n\n" +
    (gate
      ? "**CI gate: " + gate.status + "**\n\n" + gate.reason + "\n\n"
      : "") +
    record.findings.length +
    " static findings in " +
    record.groups.length +
    " candidate groups. Scanner model tokens: 0.\n\n" +
    record.scanners.map((s) => "- " + s.tool + ": " + s.status).join("\n") +
    "\n\nStatic clearance is not behavioral verification. See report.html and findings.sarif for details.\n"
  );
}
const FILES = ["evidence.json", "findings.sarif", "report.html", "summary.md"];
function bundle(record, destination, gate) {
  if (fs.existsSync(destination))
    throw Error("Output directory already exists; choose a new path.");
  // Export an allowlist, never source snapshots, shell logs, raw findings or frozen probe scripts.
  const clean = portable(record);
  if (gate) clean.ci = gate;
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const outputs = {
    "evidence.json": JSON.stringify(clean, null, 2) + "\n",
    "findings.sarif": JSON.stringify(sarif(clean, gate), null, 2) + "\n",
    "report.html": report({
      ...clean,
      root: "Local paths omitted from export",
    }),
    "summary.md": markdown(clean, gate),
  };
  const manifest = { schema: "tokenpilot.bundle/v1", files: {} };
  for (const [name, data] of Object.entries(outputs)) {
    fs.writeFileSync(path.join(destination, name), data, { mode: 0o600 });
    manifest.files[name] = digest(data);
  }
  fs.writeFileSync(
    path.join(destination, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { mode: 0o600 },
  );
  return destination;
}
function verifyBundle(directory) {
  const names = fs.readdirSync(directory).sort();
  if (
    JSON.stringify(names) !== JSON.stringify([...FILES, "manifest.json"].sort())
  )
    throw Error("Bundle has missing or unexpected files");
  for (const name of names)
    if (!fs.lstatSync(path.join(directory, name)).isFile())
      throw Error("Bundle entries must be regular files, not symlinks");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, "manifest.json"), "utf8"),
  );
  if (
    manifest.schema !== "tokenpilot.bundle/v1" ||
    JSON.stringify(Object.keys(manifest.files || {}).sort()) !==
      JSON.stringify([...FILES].sort())
  )
    throw Error("Invalid bundle manifest");
  for (const name of FILES)
    if (
      digest(fs.readFileSync(path.join(directory, name))) !==
      manifest.files[name]
    )
      throw Error("Integrity mismatch: " + name);
  return {
    status: "intact",
    files: FILES.length,
    meaning:
      "Files match this manifest. This does not authenticate the author or prove scan claims.",
  };
}
module.exports = { portable, validate, ciGate, sarif, bundle, verifyBundle };
