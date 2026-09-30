const crypto = require("node:crypto");
const modes = {
  economy: { calls: 36, repeats: 2, lines: 160, chars: 10000, minutes: 10 },
  balanced: { calls: 72, repeats: 3, lines: 260, chars: 18000, minutes: 20 },
  deep: { calls: 150, repeats: 4, lines: 400, chars: 28000, minutes: 45 },
};
const hash = (value) =>
  crypto
    .createHash("sha256")
    .update(
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value),
    )
    .digest("hex");
function risk(task, files = []) {
  const hits =
    `${task} ${files.join(" ")}`.match(
      /auth|security|crypt|payment|migration|concurren|race|public.?api|permission|schema|integrity|dependency|lockfile/gi,
    ) || [];
  return {
    broad: hits.length > 0,
    reasons: [...new Set(hits.map((x) => x.toLowerCase()))],
  };
}
function limits(input = {}) {
  const mode = modes[input.mode] ? input.mode : "economy";
  const num = (v, d, min, max) =>
    Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : d;
  return {
    ...modes[mode],
    mode,
    model: input.model || "sonnet",
    effort:
      input.effort ||
      { economy: "low", balanced: "medium", deep: "high" }[mode],
    spend: num(input.spend, 2, 0.01, 1000),
    tokens: num(input.tokens, 100000, 100, 10000000),
    minutes: num(input.minutes, modes[mode].minutes, 0.05, 240),
    repeats: num(input.repeats, modes[mode].repeats, 1, 10),
    optionalChecks: num(input.optionalChecks, 2, 0, 100),
    autoEscalate: !!input.autoEscalate,
  };
}
class Guard {
  constructor(policy, enabled = true) {
    this.policy = policy;
    this.enabled = enabled;
    this.seen = new Map();
    this.calls = 0;
    this.failures = 0;
  }
  check(name, args, fingerprint) {
    this.calls++;
    if (!this.enabled) return;
    if (this.calls > this.policy.calls)
      throw new Error(
        "Tool-call limit reached. Stop and report remaining work.",
      );
    const key = hash([name, args, fingerprint]);
    const count = (this.seen.get(key) || 0) + 1;
    this.seen.set(key, count);
    if (count > this.policy.repeats)
      throw new Error(
        "Repeated action with unchanged inputs blocked. Use new evidence or stop.",
      );
  }
}
function summarize(text, limit = 10000) {
  text = String(text);
  if (text.length <= limit) return text;
  const lines = text.split("\n");
  const evidence = lines
    .filter((x) => /error|fail|exception|warning|assert|not ok/i.test(x))
    .slice(0, 60)
    .join("\n");
  return (
    text.slice(0, Math.floor(limit * 0.35)) +
    "\n[Middle omitted; complete output saved locally]\n" +
    evidence.slice(0, Math.floor(limit * 0.3)) +
    "\n" +
    text.slice(-Math.floor(limit * 0.35))
  );
}
function usageTokens(u) {
  return u
    ? [
        "input_tokens",
        "output_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
      ].reduce((n, k) => n + (u[k] || 0), 0)
    : null;
}
module.exports = { modes, hash, risk, limits, Guard, summarize, usageTokens };
