/**
 * Deterministic screener — scores recon'd candidates 0..100 in code so the
 * screening cycle can pick and deploy without the LLM (screeningMode = "deterministic").
 *
 * Input candidate shape (from runScreeningCycle recon): { pool, sw, n, ti }
 *   pool = condensed pool from getTopCandidates
 *   sw   = checkSmartWalletsOnPool result
 *   n    = getTokenNarrative result
 *   ti   = getTokenInfo(...).results[0]
 *
 * Score = Σ weight × sub-score(0..1) + narrative bonus − penalties, clamped to 0..100.
 */
import { config } from "./config.js";
import { degenScore } from "./tools/screening.js";
import { getPoolMemory } from "./pool-memory.js";
import { compareNewestFirst } from "./evil-panda.js";

export const DEFAULT_SCORE_WEIGHTS = {
  degen: 35,        // pool efficiency (degenScore / 100)
  fresh: 20,        // newest token first
  vol24h: 15,       // token 24h volume, log-scaled $1M → $10M
  fees: 10,         // global fees paid, log-scaled 30 → 300 SOL
  holders: 10,      // top10 spread, (30 − top10) / 30
  smartWallets: 10, // any tracked smart wallet in the pool
  narrative: 5,     // bonus when a narrative exists
  pvpPenalty: 15,
  memoryPenalty: 10,
};

function num(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** 0 at `lo`, 1 at `hi`, log-scaled between. */
function logScale(value, lo, hi) {
  if (value == null || value <= 0 || lo <= 0 || hi <= lo) return 0;
  return clamp01(Math.log(value / lo) / Math.log(hi / lo));
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

export function getScoreWeights() {
  return { ...DEFAULT_SCORE_WEIGHTS, ...(config.screening.detScoreWeights || {}) };
}

function tokenAgeHours(pool) {
  const createdAt = num(pool?.token_x?.created_at ?? pool?.created_at);
  if (createdAt != null) return (Date.now() - createdAt) / 3_600_000;
  return num(pool?.token_age_hours);
}

/** Pool-memory penalty applies after ≥2 past deploys averaging a loss. */
function hasLosingHistory(poolAddress) {
  if (!poolAddress) return false;
  const mem = getPoolMemory({ pool_address: poolAddress });
  return !!mem?.known && Number(mem.total_deploys) >= 2 && Number(mem.avg_pnl_pct) < 0;
}

/**
 * Score one candidate. Returns { score, parts } where parts maps component → points
 * (penalties negative). Sum of parts, clamped to 0..100, equals score.
 */
export function scoreDeployCandidate({ pool, sw, n, ti } = {}) {
  const w = getScoreWeights();
  const s = config.screening;
  const ep = config.evilPanda || {};
  const minVol = Number(ep.min24hVolumeUsd) > 0 ? Number(ep.min24hVolumeUsd) : 1_000_000;
  const minFees = Number(ep.minTokenFeesSol) > 0 ? Number(ep.minTokenFeesSol) : Number(s.minTokenFeesSol) || 30;
  const maxTop10 = Number(ep.maxTop10Pct) > 0 ? Number(ep.maxTop10Pct) : Number(s.maxTop10Pct) || 30;
  const freshHours = Number(s.detFreshAgeHours) > 0 ? Number(s.detFreshAgeHours) : 72;

  const age = tokenAgeHours(pool);
  const top10 = num(ti?.audit?.top_holders_pct);
  const parts = {
    degen: w.degen * clamp01(degenScore(pool || {}, config.opportunity) / 100),
    fresh: age == null ? 0 : w.fresh * (1 - clamp01(age / freshHours)),
    vol24h: w.vol24h * logScale(num(ti?.volume_24h), minVol, minVol * 10),
    fees: w.fees * logScale(num(ti?.global_fees_sol), minFees, minFees * 10),
    holders: top10 == null ? 0 : w.holders * clamp01((maxTop10 - top10) / maxTop10),
    smartWallets: (sw?.in_pool?.length ?? 0) > 0 ? w.smartWallets : 0,
    narrative: n?.narrative ? w.narrative : 0,
    pvp: pool?.is_pvp ? -w.pvpPenalty : 0,
    memory: hasLosingHistory(pool?.pool) ? -w.memoryPenalty : 0,
  };
  for (const key of Object.keys(parts)) parts[key] = round1(parts[key]);
  const raw = Object.values(parts).reduce((sum, v) => sum + v, 0);
  return { score: round1(Math.min(100, Math.max(0, raw))), parts };
}

/** Score + rank: score desc, then newest token, then higher degen. Returns new array. */
export function rankCandidates(candidates = []) {
  return candidates
    .map((c) => ({ ...c, ...scoreDeployCandidate(c) }))
    .sort((a, b) =>
      (b.score - a.score) ||
      compareNewestFirst(a.pool, b.pool) ||
      (b.parts.degen - a.parts.degen));
}

/** "score 71 = degen 24 + fresh 16 + vol24h 9 − pvp 15" (zero parts omitted). */
export function formatScoreBreakdown({ score, parts }) {
  const terms = Object.entries(parts || {})
    .filter(([, v]) => v !== 0)
    .map(([k, v], i) => (v < 0 ? `− ${k} ${Math.abs(v)}` : `${i === 0 ? "" : "+ "}${k} ${v}`));
  return `score ${score}${terms.length ? ` = ${terms.join(" ")}` : ""}`;
}

function fmtPct(value, digits = 1) {
  const n = num(value);
  return n == null ? "?" : `${n.toFixed(digits)}%`;
}

function fmtNum(value, digits = 0) {
  const n = num(value);
  return n == null ? "?" : n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

/** Telegram-friendly DEPLOYED report built from the ranked winner + deploy result. */
export function buildDeployedReport({ winner, runnerUp, result, deployAmount, quoteSymbol = "SOL" }) {
  const { pool, sw, ti } = winner;
  const cov = result?.range_coverage || {};
  const range = result?.price_range;
  const wouldDeploy = result?.would_deploy;
  const smart = sw?.in_pool?.length ? sw.in_pool.map((x) => x.name || x.address?.slice(0, 4)).join(", ") : "none";
  return [
    result?.dry_run ? "🧪 DRY RUN — WOULD DEPLOY" : "🚀 DEPLOYED",
    "",
    pool.name,
    pool.pool,
    "",
    `${quoteSymbol === "SOL" ? "◎" : "$"} ${deployAmount} ${quoteSymbol} | ${result?.strategy || wouldDeploy?.strategy || config.strategy.strategy} | bin ${result?.bin_range?.active ?? "?"}`,
    range ? `Range: ${range.min} → ${range.max}` : null,
    cov.downside_pct != null
      ? `Range cover: ${fmtPct(cov.downside_pct)} downside | ${fmtPct(cov.upside_pct)} upside | ${fmtPct(cov.width_pct)} total`
      : wouldDeploy?.downside_pct != null ? `Range cover: -${wouldDeploy.downside_pct}% downside` : null,
    "",
    "MARKET",
    `Fee/TVL: ${pool.fee_active_tvl_ratio ?? "?"}%`,
    `Volume: $${fmtNum(pool.volume_window)} | 24h: $${fmtNum(ti?.volume_24h)}`,
    `TVL: $${fmtNum(pool.tvl ?? pool.active_tvl)}`,
    `Volatility: ${pool.volatility ?? "?"} | Base fee: ${pool.fee_pct ?? "?"}% | Bin step: ${pool.bin_step ?? "?"}`,
    `Mcap: $${fmtNum(pool.mcap)} | Age: ${pool.token_age_hours ?? "?"}h`,
    "",
    "AUDIT",
    `Top10: ${ti?.audit?.top_holders_pct ?? "?"}% | Bots: ${ti?.audit?.bot_holders_pct ?? "?"}%`,
    `Fees paid: ${ti?.global_fees_sol ?? "?"} SOL`,
    `Smart wallets: ${smart}`,
    "",
    "WHY THIS WON",
    formatScoreBreakdown(winner),
    runnerUp ? `Runner-up: ${runnerUp.pool.name} (score ${runnerUp.score})` : "No runner-up.",
  ].filter((line) => line != null).join("\n");
}

/** NO DEPLOY report listing each candidate's score (and deploy failures, if any). */
export function buildNoDeployReport({ ranked, minScore, failures = [] }) {
  const best = ranked[0];
  const why = failures.length
    ? `Deploy failed for every qualifying candidate (min score ${minScore}).`
    : best
      ? `Best score ${best.score} is below the minimum ${minScore}.`
      : "No candidates to score.";
  return [
    "⛔ NO DEPLOY",
    "",
    "Cycle finished with no valid entry.",
    "",
    "BEST LOOKING CANDIDATE",
    best ? `${best.pool.name} — ${formatScoreBreakdown(best)}` : "none",
    "",
    "WHY SKIPPED",
    why,
    "",
    "REJECTED",
    ...ranked.slice(0, 5).map((c) => {
      const failure = failures.find((f) => f.pool === c.pool.pool);
      return `- ${c.pool.name}: score ${c.score}${failure ? ` — deploy failed: ${failure.error}` : ""}`;
    }),
  ].join("\n");
}
