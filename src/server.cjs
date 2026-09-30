const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Security } = require("./security.cjs");
const { portable, sarif } = require("./evidence.cjs");
const { report } = require("./report.cjs");
const MAX_BODY = 24 * 1024 * 1024;
function createLocalServer({
  dataDir,
  security = new Security(path.join(dataDir, "audits")),
  canScan = () => true,
}) {
  const token = crypto.randomBytes(32).toString("hex");
  let origin,
    active = null,
    closed = false;
  const web = path.join(__dirname, "../web");
  const clean = (r) => ({ ...portable(r), root: r.root });
  const json = (res, status, value) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(value));
  };
  const read = async (req) => {
    let data = "";
    for await (const chunk of req) {
      data += chunk;
      if (Buffer.byteLength(data) > MAX_BODY) throw Error("Request too large");
    }
    return JSON.parse(data || "{}");
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    try {
      if (
        req.headers.host !== new URL(origin).host ||
        (req.headers.origin && req.headers.origin !== origin) ||
        req.headers["sec-fetch-site"] === "cross-site"
      )
        return json(res, 403, {
          error: "Only the local TokenPilot page can access this server.",
        });
      const url = new URL(req.url, origin),
        route = url.pathname;
      if (route === "/api/session" && req.method === "GET")
        return json(res, 200, {
          token,
          version: require("../package.json").version,
        });
      if (route.startsWith("/api/")) {
        if (req.headers.authorization !== "Bearer " + token)
          return json(res, 401, {
            error: "Reload TokenPilot to connect to the local server.",
          });
        if (route === "/api/status" && req.method === "GET")
          return json(res, 200, {
            active,
            history: security.history().map(clean),
          });
        if (route === "/api/capabilities" && req.method === "GET")
          return json(res, 200, security.capabilities());
        if (route === "/api/stop" && req.method === "POST") {
          security.stop();
          return json(res, 200, { stopping: !!active });
        }
        if (route === "/api/uploads" && req.method === "POST") {
          if (active || security.active || !canScan())
            return json(res, 409, {
              error: "Wait for the active scan or agent task.",
            });
          const { files } = await read(req);
          if (!Array.isArray(files) || !files.length || files.length > 256)
            throw Error(
              "Choose between 1 and 256 files. For larger projects, paste the folder path.",
            );
          let total = 0;
          const seen = new Set();
          const decoded = files.map((file) => {
            if (
              typeof file.name !== "string" ||
              !file.name ||
              file.name.length > 512 ||
              path.posix.isAbsolute(file.name) ||
              path.win32.isAbsolute(file.name) ||
              file.name.includes("\\") ||
              file.name.includes("\0") ||
              file.name.split("/").some((p) => !p || p === "." || p === "..") ||
              seen.has(file.name)
            )
              throw Error("Invalid or duplicate file name.");
            seen.add(file.name);
            if (
              typeof file.data !== "string" ||
              !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)
            )
              throw Error("Invalid file content.");
            const data = Buffer.from(file.data, "base64");
            total += data.length;
            if (data.length > 4 * 1024 * 1024 || total > 16 * 1024 * 1024)
              throw Error(
                "Choose files under 4 MB each and 16 MB total, or paste a folder path.",
              );
            return { name: file.name, data };
          });
          const root = path.join(
            dataDir,
            "uploads",
            crypto.randomUUID(),
            "selected-files",
          );
          fs.mkdirSync(root, { recursive: true, mode: 0o700 });
          try {
            for (const file of decoded) {
              const target = path.join(root, file.name);
              fs.mkdirSync(path.dirname(target), { recursive: true });
              fs.writeFileSync(target, file.data, { mode: 0o600 });
            }
          } catch (e) {
            fs.rmSync(root, { recursive: true, force: true });
            throw e;
          }
          return json(res, 201, {
            root: fs.realpathSync(root),
            files: decoded.length,
            bytes: total,
          });
        }
        if (route === "/api/sample" && req.method === "POST") {
          if (active)
            return json(res, 409, { error: "Wait for the active scan." });
          const root = path.join(
            dataDir,
            "samples",
            crypto.randomUUID(),
            "sample-project",
          );
          fs.mkdirSync(root, { recursive: true, mode: 0o700 });
          for (const name of fs.readdirSync(path.join(__dirname, "../demo")))
            fs.copyFileSync(
              path.join(__dirname, "../demo", name),
              path.join(root, name),
            );
          return json(res, 201, { root: fs.realpathSync(root) });
        }
        if (route === "/api/scans" && req.method === "POST") {
          if (active || security.active || !canScan())
            return json(res, 409, {
              error: "Wait for the active scan or agent task.",
            });
          if (!req.headers["content-type"]?.startsWith("application/json"))
            return json(res, 415, { error: "Expected JSON" });
          const body = await read(req);
          if (active || security.active || !canScan())
            return json(res, 409, {
              error: "Wait for the active scan or agent task.",
            });
          if (typeof body.root !== "string" || !path.isAbsolute(body.root))
            return json(res, 400, {
              error: "Enter an absolute local file or folder path.",
            });
          const root = fs.realpathSync(body.root);
          if (!fs.statSync(root).isDirectory() && !fs.statSync(root).isFile())
            throw Error("Choose a regular file or folder.");
          if (body.baseline && security.get(body.baseline).root !== root)
            throw Error("Baseline belongs to a different folder.");
          active = { root, status: "starting", id: null };
          // The durable scan record is the source of truth; polling never triggers a scan or a model call.
          security
            .scan(root, {
              baseline: body.baseline || null,
              onProgress: (r) => {
                active = {
                  root: r.root,
                  id: r.id,
                  status: r.status,
                  scanners: r.scanners.map((s) => ({
                    tool: s.tool,
                    status: s.status,
                  })),
                };
              },
            })
            .catch(() => {})
            .finally(() => {
              active = null;
            });
          return json(res, 202, { accepted: true });
        }
        const download = route.match(
          /^\/api\/scans\/([a-f0-9-]{36})\/(report|sarif|json)$/,
        );
        if (download && req.method === "GET") {
          const r = security.get(download[1]),
            kind = download[2];
          const body =
            kind === "report"
              ? report({ ...portable(r), root: "Local path omitted" })
              : JSON.stringify(
                  kind === "sarif" ? sarif(r) : portable(r),
                  null,
                  2,
                );
          res.writeHead(200, {
            "Content-Type":
              kind === "report"
                ? "text/html; charset=utf-8"
                : "application/json; charset=utf-8",
            "Content-Disposition":
              'attachment; filename="tokenpilot-' +
              r.id +
              "." +
              (kind === "report"
                ? "html"
                : kind === "sarif"
                  ? "sarif"
                  : "json") +
              '"',
          });
          res.end(body);
          return;
        }
        return json(res, 404, { error: "Unknown API endpoint" });
      }
      if (req.method !== "GET")
        return json(res, 405, { error: "Method not allowed" });
      const assets = {
        "/": "index.html",
        "/app.js": "app.js",
        "/style.css": "style.css",
        "/VT323-Regular.ttf": "../ui/fonts/VT323-Regular.ttf",
      };
      if (!assets[route]) return json(res, 404, { error: "Not found" });
      const mime = route.endsWith(".js")
        ? "text/javascript"
        : route.endsWith(".css")
          ? "text/css"
          : route.endsWith(".ttf")
            ? "font/ttf"
            : "text/html";
      res.writeHead(200, { "Content-Type": mime + "; charset=utf-8" });
      res.end(fs.readFileSync(path.join(web, assets[route])));
    } catch (e) {
      if (!res.headersSent)
        json(res, 400, {
          error:
            e.code === "ENOENT"
              ? "Folder or scan not found. Check the path and try again."
              : e.message,
        });
      else res.end();
    }
  });
  return {
    server,
    listen(port = 8792) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          origin = "http://127.0.0.1:" + server.address().port;
          resolve(origin);
        });
      });
    },
    close() {
      if (closed) return;
      closed = true;
      security.stop();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
module.exports = { createLocalServer };
