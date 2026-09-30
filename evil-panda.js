/**
 * Evil Panda (EP) mode rules.
 *
 *   Range : fixed -downsidePct (default -90%) single-side SOL, bins_above = 0
 *           (enforced in tools/dlmm.js deployPosition).
 *   Gates : volatility >= minVolatility (1), base fee >= minBaseFeePct (1%),
 *           bin step in allowedBinSteps (80/100/125), mcap >= minMcap (250k);
 *           after recon: token 24h volume >= $1M, has picture, fees >= 30 SOL,
 *           top10 <= 30%. Candidates sorted newest token first.
 *   Entry : entryPreset (supertrend_break) on entryInterval (15m).
 *   Exits : trailing TP + SL (state.js / getDeterministicCloseRule), plus the
 *           indicator exits below on exitInterval (15m), at any PnL:
 *             - close >= upper Bollinger band AND RSI(2) >= exitRsiLevel
 *             - RSI(2) >= exitRsiLevel
 */
import { config } from "./config.js";
import { log } from "./logger.js";
import { evaluatePreset, fetchChartIndicatorsForMint } from "./tools/chart-indicators.js";

export function isEvilPandaEnabled() {
  return !!config.evilPanda?.enabled;
}

function numeric(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Base fee in percent from a condensed candidate or a raw discovery/datapi pool object. */
export function getPoolBaseFeePct(pool) {
  return numeric(
    pool?.fee_pct ??
    pool?.base_fee_percentage ??
    pool?.base_fee_pct ??
    pool?.dlmm_params?.base_fee_pct ??
    pool?.pool_config?.base_fee_pct,
  );
}

/** Returns a reject reason string when the pool fails EP gates, else null. */
export function getEvilPandaPoolRejectReason(pool, { volatility = pool?.volatility } = {}) {
  if (!isEvilPandaEnabled()) return null;
  const ep = config.evilPanda;
  const vol = numeric(volatility);
  if (vol == null || vol < ep.minVolatility) {
    return `EP: volatility ${vol ?? "unknown"} < ${ep.minVolatility}`;
  }
  const feePct = getPoolBaseFeePct(pool);
  if (feePct == null || feePct < ep.minBaseFeePct) {
    return `EP: base fee ${feePct ?? "unknown"}% < ${ep.minBaseFeePct}%`;
  }
  const binStep = numeric(pool?.bin_step ?? pool?.dlmm_params?.bin_step ?? pool?.pool_config?.bin_step);
  const allowedSteps = Array.isArray(ep.allowedBinSteps) ? ep.allowedBinSteps : [];
  if (allowedSteps.length > 0 && (binStep == null || !allowedSteps.includes(binStep))) {
    return `EP: bin step ${binStep ?? "unknown"} not in [${allowedSteps.join("/")}]`;
  }
  const mcap = numeric(pool?.mcap ?? pool?.token_x?.market_cap ?? pool?.base_token_market_cap);
  if (ep.minMcap > 0 && (mcap == null || mcap < ep.minMcap)) {
    return `EP: mcap $${mcap ?? "unknown"} < $${ep.minMcap}`;
  }
  return null;
}

/**
 * Token-level EP gates, applied after recon on the Jupiter token info (getTokenInfo result).
 * Missing data rejects — EP is strict about coin selection.
 */
export function getEvilPandaTokenRejectReason(tokenInfo) {
  if (!isEvilPandaEnabled()) return null;
  const ep = config.evilPanda;
  if (!tokenInfo) return "EP: token info unavailable";
  const volume24h = numeric(tokenInfo.volume_24h);
  if (ep.min24hVolumeUsd > 0 && (volume24h == null || volume24h < ep.min24hVolumeUsd)) {
    return `EP: 24h volume $${volume24h ?? "unknown"} < $${ep.min24hVolumeUsd}`;
  }
  if (ep.requireIcon && !tokenInfo.has_icon) {
    return "EP: token has no picture";
  }
  const feesSol = numeric(tokenInfo.global_fees_sol);
  if (ep.minTokenFeesSol > 0 && (feesSol == null || feesSol < ep.minTokenFeesSol)) {
    return `EP: token fees ${feesSol ?? "unknown"} SOL < ${ep.minTokenFeesSol} SOL`;
  }
  const top10 = numeric(tokenInfo.audit?.top_holders_pct);
  if (ep.maxTop10Pct > 0 && (top10 == null || top10 > ep.maxTop10Pct)) {
    return `EP: top10 ${top10 ?? "unknown"}% > ${ep.maxTop10Pct}%`;
  }
  return null;
}

/** Token age in hours from a condensed candidate (token_age_hours) or raw pool (created_at ms). */
function tokenAgeHours(pool) {
  const createdAt = numeric(pool?.token_x?.created_at ?? pool?.created_at);
  if (createdAt != null) return (Date.now() - createdAt) / 3_600_000;
  return numeric(pool?.token_age_hours);
}

/** EP candidate order: newest token first; unknown ages last. */
export function compareNewestFirst(a, b) {
  const ageA = tokenAgeHours(a);
  const ageB = tokenAgeHours(b);
  if (ageA == null && ageB == null) return 0;
  if (ageA == null) return 1;
  if (ageB == null) return -1;
  return ageA - ageB;
}

// mint → { at, payload } — keeps the 3s PnL poller from hammering the indicator API.
const _exitPayloadCache = new Map();

async function getExitPayload(mint) {
  const ttlMs = Math.max(5, Number(config.evilPanda.exitCheckSec ?? 60)) * 1000;
  const cached = _exitPayloadCache.get(mint);
  if (cached && Date.now() - cached.at < ttlMs) return cached.payload;
  try {
    const payload = await fetchChartIndicatorsForMint(mint, { interval: config.evilPanda.exitInterval });
    _exitPayloadCache.set(mint, { at: Date.now(), payload });
    return payload;
  } catch (error) {
    log("indicators_warn", `EP exit indicator fetch failed for ${mint.slice(0, 8)}: ${error.message}`);
    // Cache the failure briefly too, so an outage doesn't turn into a request storm.
    _exitPayloadCache.set(mint, { at: Date.now(), payload: null });
    return null;
  }
}

/**
 * EP indicator exit check. Returns { action: "CLOSE", rule, reason } or null.
 * Never fires when indicator data is unavailable or the PnL tick is suspect.
 */
export async function checkEvilPandaIndicatorExit(position) {
  if (!isEvilPandaEnabled()) return null;
  const mint = position?.base_mint;
  if (!mint) return null;
  if (position.pnl_pct_suspicious) return null;
  const ep = config.evilPanda;
  if (!ep.indicatorExitsAnyPnl && !(Number(position.pnl_pct) > 0)) return null;

  const payload = await getExitPayload(mint);
  if (!payload?.latest) return null;

  const thresholds = { overbought: ep.exitRsiLevel };
  const tf = ep.exitInterval === "15_MINUTE" ? "15m" : "5m";
  const bbRsi = evaluatePreset("exit", "bb_plus_rsi", payload, thresholds);
  if (bbRsi.confirmed) {
    return { action: "CLOSE", rule: "EP_BB_RSI", reason: `EP exit ${tf}: BB upper + RSI(2) >= ${ep.exitRsiLevel} (RSI ${bbRsi.signal?.rsi})` };
  }
  const rsi = evaluatePreset("exit", "rsi_reversal", payload, thresholds);
  if (rsi.confirmed) {
    return { action: "CLOSE", rule: "EP_RSI", reason: `EP exit ${tf}: RSI(2) ${rsi.signal?.rsi} >= ${ep.exitRsiLevel}` };
  }
  return null;
}
