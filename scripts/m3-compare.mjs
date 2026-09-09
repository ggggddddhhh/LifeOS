/**
 * M3 双路径对比汇总：读取 m3-local-results.json 与 m3-python-results.json，
 * 计算 5 大类指标并写 m3-comparison.json。
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = path.resolve(process.cwd(), "docs/eval");
const load = (name) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));
const local = load("m3-local-results.json");
const python = load("m3-python-results.json");

function pct(n, d) {
  return d === 0 ? 0 : +((n / d) * 100).toFixed(1);
}
function quantile(arr, q) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
function stats(arr) {
  return {
    avg: Math.round(arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length)),
    p50: quantile(arr, 0.5),
    p95: quantile(arr, 0.95),
  };
}

function summarize(data) {
  const p = data.planner.filter((r) => r.ok);
  const pAll = data.planner;
  const r = data.replan.filter((x) => x.ok);
  const rAll = data.replan;
  const lat = [...pAll.filter((x) => x.ok).map((x) => x.latencyMs), ...rAll.filter((x) => x.ok).map((x) => x.latencyMs)];
  return {
    planner: {
      calls: pAll.length,
      passRate: pct(p.filter((x) => x.taskCount >= 3 && x.taskCount <= 8 && x.dupCount === 0 && x.depsInvalid === 0).length, p.length),
      failRate: pct(pAll.length - p.length, pAll.length),
      taskCountDist: distribution(p.map((x) => x.taskCount)),
      minimalRate: pct(p.filter((x) => x.minimal).length, p.length),
      dupRate: pct(p.filter((x) => x.dupCount > 0).length, p.length),
      rawDateOutOfRangeRate: pct(p.filter((x) => x.rawOutOfRange > 0).length, p.length),
      sanitizedDateOutOfRangeRate: pct(p.filter((x) => x.sanitizedOutOfRange > 0).length, p.length),
      depsInvalidRate: pct(p.filter((x) => x.depsInvalid > 0).length, p.length),
      overloadRate: pct(p.filter((x) => x.overload).length, p.length),
    },
    replan: {
      calls: rAll.length,
      passRate: pct(r.filter((x) => x.reasonOk && x.taskCount >= 1 && x.taskCount <= x.openCount + 1 && !x.overload).length, r.length),
      failRate: pct(rAll.length - r.length, rAll.length),
      expansionAvg: +(r.reduce((s, x) => s + x.expansion, 0) / Math.max(1, r.length)).toFixed(2),
      expandedRate: pct(r.filter((x) => x.taskCount > x.openCount + 1).length, r.length),
      overloadRate: pct(r.filter((x) => x.overload).length, r.length),
      doneLeakRate: pct(r.filter((x) => x.doneLeak > 0).length, r.length),
      minimalRate: pct(r.filter((x) => x.minimal).length, r.length),
      keptAvg: +(r.reduce((s, x) => s + x.kept, 0) / Math.max(1, r.length)).toFixed(1),
    },
    latency: stats(lat),
    llmRetryRate: pct([...pAll, ...rAll].filter((x) => x.ok && x.llmCalls === 2).length, [...pAll, ...rAll].filter((x) => x.ok && x.llmCalls !== undefined).length),
    minimalSamples: {
      planner: pAll.filter((x) => x.ok && x.minimal).map((x) => ({ goal: x.goal, round: x.round, taskCount: x.taskCount })),
      replan: rAll.filter((x) => x.ok && x.minimal).map((x) => ({ scenario: x.scenario, goal: x.goalTitle, round: x.round, taskCount: x.taskCount, openCount: x.openCount })),
    },
  };
}

function distribution(nums) {
  const dist = {};
  for (const n of nums) dist[n] = (dist[n] ?? 0) + 1;
  return dist;
}

const out = {
  ranAt: new Date().toISOString(),
  rounds: local.rounds,
  local: { ...summarize(local), source: "m3-local-results.json" },
  python: { ...summarize(python), source: "m3-python-results.json" },
};
writeFileSync(path.join(dir, "m3-comparison.json"), JSON.stringify(out, null, 2), "utf8");
console.log(JSON.stringify(out, null, 2));
