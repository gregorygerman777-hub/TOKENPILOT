# TokenPilot benchmark

## Result

**69.0% fewer total reported tokens across 8 fully accounted, independently accepted matched pairs.** This is a small synthetic fixture result, not a promised saving on real repositories. The same reported model and effort were used within each pair. No model-price or effort change is included in this comparison.

Controller enabled: **143,853** tokens for 8 correct completions (17,982 per task). Controller disabled: **463,761** tokens (57,970 per task). Total tokens means uncached input + cache creation + cache reads + output. Reasoning, when reported, is a subset of output and is not added again.

## Failures remain in the record

There were **22 attempts**, **17 correct completed tasks**, and **5 attempts without final usage** in the final study and its targeted rechecks. Provider retry errors and an elapsed-time termination interrupted part of repetition 2. All failures remain in the raw results. We cannot calculate minimum total consumption per correct task over **all attempts** because failed-run accounting is missing. Their usage is unknown, not zero. The headline describes only the fully accounted successful pairs and must not be interpreted as an all-attempt efficiency estimate.

Three pairs were rechecked after the interruption. The originally successful but unmatched broader-validation run is retained in the all-attempt record, not silently counted in a matched pair. This retest selection and the small sample limit the strength of the conclusion.

## Per-case variability

Two accounted repetitions per case; values are total tokens per run.

| Case | Controller on, range | Controller off, range | Mean on | Mean off |
|---|---:|---:|---:|---:|
| routine | 13,902–13,909 | 46,367–46,377 | 13,906 | 46,372 |
| logic | 18,804–18,830 | 59,253–59,426 | 18,817 | 59,340 |
| debug | 18,953–18,960 | 59,511–71,336 | 18,957 | 65,424 |
| broad-validation | 20,219–20,276 | 60,719–60,772 | 20,248 | 60,746 |

CLI-reported API-price estimates for those paired runs: $0.1474 enabled and $0.3898 disabled. These estimates are not subscription allowance consumption or an invoice. Cache-write/read mix and warm-cache order vary, so the token reduction and cost-estimate reduction are separate observations.

Mean main-process CPU per accounted enabled task: 1024.3 ms; disabled: 1629.4 ms. This measures local process CPU, not subprocess CPU or a causal decomposition of every optimization. Wall times and raw usage categories are stored per run. Controller model usage is **0 tokens**: there is no AI supervisor.

## Method

- Official Claude Code CLI 2.1.283 on macOS arm64. Reported model: claude-sonnet-5. Effort is low except the public-interface case, which uses medium on both sides.
- Every run begins in a separate temporary Git repository with identical fixture files and acceptance criteria. No run resumes another run's provider session.
- Four cases: spelling edit, clamp logic, average regression debugging, and public API input validation with unit and integration checks. Independent assertions outside the agent workspace check correctness and verify that check scripts were not changed.
- Controller-on uses the compact system prompt, bounded context, duplicate-read suppression, repeat limits and eligible check caching. Controller-off uses the stock Claude coding prompt and the same permitted MCP toolset, with those optional efficiency transforms disabled. Both retain filesystem boundaries, approval requirements, acceptance gates and overall spend/time limits. This is an ablation of TokenPilot's workflow, not a comparison against unrestricted native Claude Code.
- Model and effort are held equal within each pair. The benchmark does not attribute savings to choosing a cheaper model. Aliases can move over time; the actual model is recorded.
- The initial two-repetition order alternates on/off to reduce order effects. Targeted rechecks use on/off order and can benefit differently from a warm provider cache. No statistical confidence interval is claimed for two tiny fixtures per case.
- Prompt compression is the main structural difference: the stable TokenPilot system prompt omits instructions for native tools that this integration does not expose. The experiment combines workflow controls; it does not independently estimate the effect of each one.

## Reproduce

From the source directory with the official CLI signed in:

```sh
REPETITIONS=2 MODEL=sonnet BENCHMARK_OUTPUT=benchmark/new-results npm run benchmark
# Optional focused rerun:
CASES=logic,debug REPETITIONS=1 BENCHMARK_OUTPUT=benchmark/focused npm run benchmark
```

This consumes real provider usage. Each run has a $0.60 reported spend ceiling, a three-minute local time limit and a 200,000 delayed token threshold. The benchmark never auto-approves arbitrary commands. Inspect every failure, including missing accounting. The generic summary sets tokens-per-correct-completion to null when any run lacks usage.

## Evidence files

- `benchmark/final-results/results.json`: all 16 initial final-study attempts, including 5 unsuccessful or incomplete runs.
- `benchmark/network-recheck/results.json`: all 6 targeted follow-up attempts.
- `benchmark/paired-analysis.json`: the exact eight accounted pair selections and total token reduction.
- Corresponding `runs/` directories: raw provider events, prompts, local tool/check logs and persisted task results.
- `benchmark/results/`: earlier prototype before compact-system-prompt optimization. Several results lack final usage because the original completion timer was too short; these are excluded from the final comparison and preserved for transparency.
- `benchmark/accounting-recheck/`: the targeted accounting-timer check before prompt optimization.

The app's general correctness and real-world savings still need wider repository trials. Cached checks, blocked actions and shorter logs alone are never labeled measured token savings.
