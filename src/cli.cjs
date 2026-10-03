#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { Security } = require("./security.cjs");
const { report } = require("./report.cjs");
const { bundle, verifyBundle, ciGate, portable } = require("./evidence.cjs");
function options(args, allowed) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !allowed.includes(args[i]) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    )
      throw Error("Invalid or missing option: " + args[i]);
    if (result[args[i]]) throw Error("Duplicate option: " + args[i]);
    result[args[i]] = args[i + 1];
  }
  return result;
}
async function main() {
  const [command, target, ...args] = process.argv.slice(2);
  const base =
    process.env.TOKENPILOT_DATA ||
    (process.platform === "darwin"
      ? path.join(os.homedir(), "Library/Application Support/TokenPilot/tasks")
      : process.platform === "win32"
        ? path.join(
            process.env.LOCALAPPDATA || os.homedir(),
            "TokenPilot/tasks",
          )
        : path.join(
            process.env.XDG_DATA_HOME ||
              path.join(os.homedir(), ".local/share"),
            "TokenPilot/tasks",
          ));
  const security = new Security(
    process.env.TOKENPILOT_AUDITS || path.join(base, "audits"),
  );
  process.once("SIGINT", () => security.stop());
  const output = (value) => console.log(JSON.stringify(value, null, 2));
  if (command === "serve") {
    const port = Number(target || 8792);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || args.length)
      throw Error("Usage: tokenpilot serve [port]");
    const server = require("./server.cjs").createLocalServer({
      dataDir: base,
      security,
    });
    console.log("TokenPilot local workbench: " + (await server.listen(port)));
    process.once("SIGINT", () => server.close());
    process.once("SIGTERM", () => server.close());
    return;
  }
  if (command === "doctor" || command === "status") {
    output(security.capabilities());
    return;
  }
  if (command === "demo") {
    if (!target || args.length)
      throw Error("Usage: tokenpilot demo <new-output-directory>");
    const result = await require("./demo.cjs").demo(
      security,
      path.resolve(target),
      (line) => console.error(line),
    );
    output(result);
    process.exitCode = result.status === "scanner-cleared" ? 0 : 2;
    return;
  }
  if (command === "verify-bundle") {
    if (!target || args.length)
      throw Error("Usage: tokenpilot verify-bundle <directory>");
    output(verifyBundle(path.resolve(target)));
    return;
  }
  if (command === "bundle") {
    if (!target || args.length !== 1)
      throw Error("Usage: tokenpilot bundle <run-id> <new-output-directory>");
    console.log(bundle(security.get(target), path.resolve(args[0])));
    return;
  }
  if (command === "scan" || command === "ci") {
    if (!target)
      throw Error(
        "Usage: tokenpilot " +
          command +
          " <project> [--baseline " +
          (command === "ci" ? "evidence.json" : "run-id") +
          "] [--output <new-directory>]",
      );
    const flags = options(args, ["--baseline", "--output"]);
    const root = fs.realpathSync(path.resolve(target));
    const destination = flags["--output"]
      ? path.resolve(flags["--output"])
      : null;
    if (
      destination &&
      (destination === root || destination.startsWith(root + path.sep))
    )
      throw Error(
        "Write evidence outside the scanned project to avoid scanning generated reports.",
      );
    if (destination && fs.existsSync(destination))
      throw Error("Output directory already exists; choose a new path.");
    let baseline;
    if (command === "ci" && flags["--baseline"])
      baseline = require("./evidence.cjs").validate(
        JSON.parse(fs.readFileSync(flags["--baseline"], "utf8")),
      );
    const r = await security.scan(root, {
      baseline: command === "scan" ? flags["--baseline"] : null,
      onProgress: (r) =>
        console.error(r.scanners.length + "/2 scanners finished"),
    });
    if (command === "ci") {
      const gate = ciGate(r, baseline);
      if (destination) bundle(r, destination, gate);
      output({ gate, evidence: portable(r), output: destination });
      process.exitCode = gate.exitCode;
    } else {
      if (destination) bundle(r, destination);
      output(r);
      process.exitCode = ["completed", "scanner-cleared", "verified"].includes(
        r.status,
      )
        ? r.findings.length
          ? 1
          : 0
        : 2;
    }
    return;
  }
  if (command === "repair") {
    const flags = options(args, ["--output", "--max", "--model", "--spend"]);
    if (!target || !flags["--output"])
      throw Error(
        "Usage: tokenpilot repair <git-project> --output <new-directory> [--max 20] [--model sonnet] [--spend 0.6]",
      );
    const { repairAll } = require("./pipeline.cjs");
    const r = await repairAll(target, {
      security,
      dataDir: base,
      output: flags["--output"],
      max: Number(flags["--max"] || 20),
      limits: {
        model: flags["--model"],
        spend: flags["--spend"] ? Number(flags["--spend"]) : undefined,
      },
      onProgress: (p) =>
        console.error(
          p.stage === "detect"
            ? "Scanning a private clone..."
            : `Repairing ${p.index + 1}/${p.total}: ${p.group.rule} in ${p.group.file}`,
        ),
    });
    output({
      report: path.join(r.output, "report.html"),
      patch: path.join(r.output, "fixes.patch"),
      findings: r.findings.length,
      attempted: r.attempted,
      verified: r.repairs.filter((x) => x.outcome === "verified").length,
      repairTokens: r.repairs.reduce((n, x) => n + (x.tokens || 0), 0),
    });
    return;
  }
  if (command === "report") {
    if (!target || args.length > 1)
      throw Error("Usage: tokenpilot report <run-id> [output.html]");
    const r = security.get(target),
      file = path.resolve(args[0] || "tokenpilot-" + r.id + ".html");
    fs.writeFileSync(file, report(r), { mode: 0o600 });
    console.log(file);
    return;
  }
  if (command === "history") {
    output(
      security
        .history()
        .map(({ id, root, status, started }) => ({
          id,
          root,
          status,
          started,
        })),
    );
    return;
  }
  if (command && !["help", "--help", "-h"].includes(command))
    throw Error("Unknown command: " + command);
  console.log(
    "TokenPilot\n  serve [port]\n  doctor (or status)\n  demo <new-directory>\n  scan <project> [--baseline <run-id>] [--output <new-directory>]\n  ci <project> [--baseline <evidence.json>] [--output <new-directory>]\n  bundle <run-id> <new-directory>\n  verify-bundle <directory>\n  history\n  report <run-id> [output.html]\n  repair <git-project> --output <new-directory> [--max 20] [--model sonnet] [--spend 0.6]\n\nNo AI account needed for scanning, CI, demos or exports. repair uses Claude Code on a private clone.\nCI: 0 passes the selected policy; 1 findings/regression; 2 incomplete/error.",
  );
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 2;
});
