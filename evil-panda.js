/**
 * Evil Panda (EP) mode rules.
 *
 *   Range : fixed -downsidePct (default -90%) single-side SOL, bins_above = 0
 *           (enforced in tools/dlmm.js deployPosition).
 *   Gates : volatility >= minVolatility (1), base fee >= minBaseFeePct (1%).
 *   Entry : entryPreset (supertrend_break) on entryInterval (5m).
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
  return null;
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
