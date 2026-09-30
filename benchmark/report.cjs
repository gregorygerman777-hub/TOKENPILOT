// Generate the report for this recorded experiment without discarding failed attempts.
const fs = require("node:fs");
const path = require("node:path");
const base = __dirname;
const read = (n) =>
  JSON.parse(fs.readFileSync(path.join(base, n, "results.json"))).rows;
const original = read("final-results"),
  recheck = read("network-recheck"),
  all = [...original, ...recheck];
const pairs = [];
for (const id of ["routine", "logic", "debug", "broad-validation"]) {
  for (let repetition = 1; repetition <= 2; repetition++) {
    const source = repetition === 1 || id === "routine" ? original : recheck;
    const rep = source === original ? repetition : 1;
    const rows = source.filter((r) => r.case === id && r.repetition === rep);
    if (
      rows.length !== 2 ||
      rows.some((r) => !r.correct || !r.completed || r.tokens == null)
    )
      continue;
    pairs.push({
      case: id,
      repetition,
      on: rows.find((r) => r.controller),
      off: rows.find((r) => !r.controller),
    });
  }
}
const on = pairs.reduce((n, p) => n + p.on.tokens, 0),
  off = pairs.reduce((n, p) => n + p.off.tokens, 0);
const successful = all.filter((r) => r.correct && r.completed),
  unknown = all.filter((r) => r.tokens == null);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const savings = 100 * (1 - on / off);
const minmax = (xs) =>
  `${Math.min(...xs).toLocaleString()}–${Math.max(...xs).toLocaleString()}`;
let md = `# TokenPilot benchmark\n\n## Result\n\n**${savings.toFixed(1)}% fewer total reported tokens across ${pairs.length} fully accounted, independently accepted matched pairs.** This is a small synthetic fixture result, not a promised saving on real repositories. The same reported model and effort were used within each pair. No model-price or effort change is included in this comparison.\n\nController enabled: **${on.toLocaleString()}** tokens for ${pairs.length} correct completions (${Math.round(on / pairs.length).toLocaleString()} per task). Controller disabled: **${off.toLocaleString()}** tokens (${Math.round(off / pairs.length).toLocaleString()} per task). Total tokens means uncached input + cache creation + cache reads + output. Reasoning, when reported, is a subset of output and is not added again.\n\n## Failures remain in the record\n\nThere were **${all.length} attempts**, **${successful.length} correct completed tasks**, and **${unknown.length} attempts without final usage** in the final study and its targeted rechecks. Provider retry errors and an elapsed-time termination interrupted part of repetition 2. All failures remain in the raw results. We cannot calculate minimum total consumption per correct task over **all attempts** because failed-run accounting is missing. Their usage is unknown, not zero. The headline describes only the fully accounted successful pairs and must not be interpreted as an all-attempt efficiency estimate.\n\nThree pairs were rechecked after the interruption. The originally successful but unmatched broader-validation run is retained in the all-attempt record, not silently counted in a matched pair. This retest selection and the small sample limit the strength of the conclusion.\n\n## Per-case variability\n\nTwo accounted repetitions per case; values are total tokens per run.\n\n| Case | Controller on, range | Controller off, range | Mean on | Mean off |\n|---|---:|---:|---:|---:|\n`;
for (const id of ["routine", "logic", "debug", "broad-validation"]) {
  const ps = pairs.filter((p) => p.case === id),
    a = ps.map((p) => p.on.tokens),
    b = ps.map((p) => p.off.tokens);
  md += `| ${id} | ${minmax(a)} | ${minmax(b)} | ${Math.round(mean(a)).toLocaleString()} | ${Math.round(mean(b)).toLocaleString()} |\n`;
}
const costOn = pairs.reduce((n, p) => n + p.on.cost, 0),
  costOff = pairs.reduce((n, p) => n + p.off.cost, 0);
md += `\nCLI-reported API-price estimates for those paired runs: $${costOn.toFixed(4)} enabled and $${costOff.toFixed(4)} disabled. These estimates are not subscription allowance consumption or an invoice. Cache-write/read mix and warm-cache order vary, so the token reduction and cost-estimate reduction are separate observations.\n\nMean main-process CPU per accounted enabled task: ${mean(pairs.map((p) => p.on.controllerCpuMs)).toFixed(1)} ms; disabled: ${mean(pairs.map((p) => p.off.controllerCpuMs)).toFixed(1)} ms. This measures local process CPU, not subprocess CPU or a causal decomposition of every optimization. Wall times and raw usage categories are stored per run. Controller model usage is **0 tokens**: there is no AI supervisor.\n\n## Method\n\n- Official Claude Code CLI 2.1.283 on macOS arm64. Reported model: ${[...new Set(pairs.map((p) => p.on.model))].join(", ")}. Effort is low except the public-interface case, which uses medium on both sides.\n- Every run begins in a separate temporary Git repository with identical fixture files and acceptance criteria. No run resumes another run's provider session.\n- Four cases: spelling edit, clamp logic, average regression debugging, and public API input validation with unit and integration checks. Independent assertions outside the agent workspace check correctness and verify that check scripts were not changed.\n- Controller-on uses the compact system prompt, bounded context, duplicate-read suppression, repeat limits and eligible check caching. Controller-off uses the stock Claude coding prompt and the same permitted MCP toolset, with those optional efficiency transforms disabled. Both retain filesystem boundaries, approval requirements, acceptance gates and overall spend/time limits. This is an ablation of TokenPilot's workflow, not a comparison against unrestricted native Claude Code.\n- Model and effort are held equal within each pair. The benchmark does not attribute savings to choosing a cheaper model. Aliases can move over time; the actual model is recorded.\n- The initial two-repetition order alternates on/off to reduce order effects. Targeted rechecks use on/off order and can benefit differently from a warm provider cache. No statistical confidence interval is claimed for two tiny fixtures per case.\n- Prompt compression is the main structural difference: the stable TokenPilot system prompt omits instructions for native tools that this integration does not expose. The experiment combines workflow controls; it does not independently estimate the effect of each one.\n\n## Reproduce\n\nFrom the source directory with the official CLI signed in:\n\n\`\`\`sh\nREPETITIONS=2 MODEL=sonnet BENCHMARK_OUTPUT=benchmark/new-results npm run benchmark\n# Optional focused rerun:\nCASES=logic,debug REPETITIONS=1 BENCHMARK_OUTPUT=benchmark/focused npm run benchmark\n\`\`\`\n\nThis consumes real provider usage. Each run has a $0.60 reported spend ceiling, a three-minute local time limit and a 200,000 delayed token threshold. The benchmark never auto-approves arbitrary commands. Inspect every failure, including missing accounting. The generic summary sets tokens-per-correct-completion to null when any run lacks usage.\n\n## Evidence files\n\n- \`benchmark/final-results/results.json\`: all 16 initial final-study attempts, including 5 unsuccessful or incomplete runs.\n- \`benchmark/network-recheck/results.json\`: all 6 targeted follow-up attempts.\n- \`benchmark/paired-analysis.json\`: the exact eight accounted pair selections and total token reduction.\n- Corresponding \`runs/\` directories: raw provider events, prompts, local tool/check logs and persisted task results.\n- \`benchmark/results/\`: earlier prototype before compact-system-prompt optimization. Several results lack final usage because the original completion timer was too short; these are excluded from the final comparison and preserved for transparency.\n- \`benchmark/accounting-recheck/\`: the targeted accounting-timer check before prompt optimization.\n\nThe app's general correctness and real-world savings still need wider repository trials. Cached checks, blocked actions and shorter logs alone are never labeled measured token savings.\n`;
fs.writeFileSync(path.join(base, "../BENCHMARK.md"), md);
fs.writeFileSync(
  path.join(base, "paired-analysis.json"),
  JSON.stringify(
    {
      pairs,
      on,
      off,
      savingsPercent: savings,
      allAttempts: all.length,
      correctCompleted: successful.length,
      missingAccounting: unknown.length,
      allAttemptTokensPerCorrectCompletion: null,
    },
    null,
    2,
  ),
);
console.log({
  pairedRuns: pairs.length,
  on,
  off,
  savingsPercent: savings,
  allAttempts: all.length,
  missingAccounting: unknown.length,
});
