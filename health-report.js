/**
 * Hourly health report — built in code, read-only (no LLM, no tool calls).
 * Replaces the old LLM health check, which ran with MANAGER tools and could act on positions.
 */
import { config } from "./config.js";

function num(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function money(value, cur) {
  const n = num(value);
  if (n == null) return "?";
  return `${n < 0 ? "-" : ""}${cur}${Math.abs(n).toFixed(2)}`;
}

function signedPct(value) {
  const n = num(value);
  if (n == null) return "?";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function fmtAge(minutes) {
  const m = num(minutes);
  if (m == null) return "?";
  if (m < 60) return `${Math.round(m)}m`;
  return `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, "0")}m`;
}

/**
 * @param {object} args
 * @param {object} args.wallet       getWalletBalances() result
 * @param {object} args.positions    getMyPositions() result
 * @param {object|null} args.performance  getPerformanceSummary() result
 * @param {(address: string) => object|null} [args.getTracked]  state.js getTrackedPosition
 * @returns {string} plain-text report
 */
export function buildHealthReport({ wallet, positions, performance = null, getTracked = () => null }) {
  const cur = config.management.solMode ? "◎" : "$";
  const mgmt = config.management;
  const list = positions?.positions || [];

  const totalValue = list.reduce((s, p) => s + (num(p.total_value_usd) ?? 0), 0);
  const totalPnl = list.reduce((s, p) => s + (num(p.pnl_usd) ?? 0), 0);
  const totalFees = list.reduce((s, p) => s + (num(p.unclaimed_fees_usd) ?? 0), 0);

  const lines = [
    "🩺 Health Check",
    "",
    `Wallet: ${num(wallet?.sol)?.toFixed(3) ?? "?"} SOL${wallet?.sol_usd != null ? ` ($${wallet.sol_usd})` : ""}${num(wallet?.usdc) > 0 ? ` | ${num(wallet.usdc).toFixed(2)} USDC` : ""}`,
    `Positions: ${positions?.total_positions ?? list.length}/${config.risk.maxPositions}`,
  ];

  if (list.length > 0) {
    lines.push(
      `Open value: ${money(totalValue, cur)} | PnL: ${money(totalPnl, cur)} | Unclaimed fees: ${money(totalFees, cur)}`,
      "",
    );
    const flags = [];
    list.forEach((p, i) => {
      const tracked = getTracked(p.position) || {};
      const peak = num(tracked.peak_pnl_pct);
      const trailing = tracked.trailing_active ? ` | trailing on (peak ${signedPct(peak)})` : "";
      const range = p.in_range === false ? `🔴 OOR ${fmtAge(p.minutes_out_of_range)}` : "🟢 in range";
      lines.push(
        `${i + 1}. ${p.pair || p.pool?.slice(0, 8) || "?"}`,
        `   ${money(p.total_value_usd, cur)} | PnL ${money(p.pnl_usd, cur)} (${signedPct(p.pnl_pct)}) | fees ${money(p.unclaimed_fees_usd, cur)}`,
        `   ${range} | age ${fmtAge(p.age_minutes)}${trailing}`,
      );

      const pnlPct = num(p.pnl_pct);
      if (p.pnl_pct_suspicious) flags.push(`${p.pair}: PnL reading unreliable this tick`);
      else if (pnlPct != null && num(mgmt.stopLossPct) != null && pnlPct <= mgmt.stopLossPct * 0.7) {
        flags.push(`${p.pair}: PnL ${signedPct(pnlPct)} is near stop loss ${mgmt.stopLossPct}%`);
      }
      if (p.in_range === false && num(p.minutes_out_of_range) >= mgmt.outOfRangeWaitMinutes * 0.5) {
        flags.push(`${p.pair}: out of range ${fmtAge(p.minutes_out_of_range)} (closes at ${mgmt.outOfRangeWaitMinutes}m)`);
      }
    });
    if (flags.length) lines.push("", "⚠️ Watch", ...flags.map((f) => `- ${f}`));
  } else {
    lines.push("No open positions.");
  }

  if (performance) {
    lines.push(
      "",
      "All-time (closed)",
      `${performance.total_positions_closed} closed | win rate ${performance.win_rate_pct}% | avg PnL ${signedPct(performance.avg_pnl_pct)} | total ${money(performance.total_pnl_usd, "$")}`,
    );
  }

  lines.push(
    "",
    `Rules: SL ${mgmt.stopLossPct}% | trailing ${mgmt.trailingTakeProfit ? `${mgmt.trailingTriggerPct}%/${mgmt.trailingDropPct}%` : "off"}${config.evilPanda?.enabled ? " | EP mode" : ""}`,
  );
  return lines.join("\n");
}
