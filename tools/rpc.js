/**
 * Read-only RPC for management / reporting (health check, /status, /wallet, CLI balance).
 *
 * Screening, deploy, close, claim and swap do NOT use this — they stay on RPC_URL (Helius).
 * Reads go to the free endpoint first (config.rpc.readUrl, default the keyless public
 * Helius endpoint) and fall back to the keyed Helius RPC on any error.
 */
import { Connection } from "@solana/web3.js";
import { config } from "../config.js";
import { log } from "../logger.js";

let _readConnection = null;
let _fallbackConnection = null;
const _lastWarnAt = new Map(); // label → ms, throttles fallback warnings

export function getFallbackRpcUrl() {
  if (process.env.RPC_URL) return process.env.RPC_URL;
  if (process.env.HELIUS_API_KEY) return `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
  return null;
}

export function getReadConnection() {
  if (!_readConnection) _readConnection = new Connection(config.rpc.readUrl, "confirmed");
  return _readConnection;
}

export function getFallbackConnection() {
  if (!_fallbackConnection) {
    const url = getFallbackRpcUrl();
    if (!url) throw new Error("No fallback RPC: set RPC_URL or HELIUS_API_KEY");
    _fallbackConnection = new Connection(url, "confirmed");
  }
  return _fallbackConnection;
}

/** Run fn(readConn); on any error retry once with the keyed Helius fallback. */
export async function withReadFallback(label, fn) {
  try {
    return await fn(getReadConnection());
  } catch (error) {
    const now = Date.now();
    if (now - (_lastWarnAt.get(label) ?? 0) > 60_000) {
      _lastWarnAt.set(label, now);
      log("rpc_warn", `${label}: free RPC failed (${error.message}) — falling back to Helius`);
    }
    return fn(getFallbackConnection());
  }
}

/** Test hook: drop cached connections (e.g. after readUrl changes). */
export function resetRpcConnections() {
  _readConnection = null;
  _fallbackConnection = null;
}
