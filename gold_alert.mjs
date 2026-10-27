// XAU/USD alert bot. Runs once per call (GitHub Actions calls it every 5 minutes).
// Downloads candles from Twelve Data, runs the detection in detect.mjs, and sends a Telegram message.
//
// Required environment variables (set them as GitHub secrets):
//   TWELVE_DATA_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
// Optional (set as GitHub variables or leave out):
//   LEVELS            extra levels, comma separated, e.g. "4150, 4200"
//   ROUND_STEP        default 50
//   ATR_BUFFER        default 0.25
//   TREND_FILTER      "h1" to alert order block retests only when they agree with the 1H trend
//   FORCE_TEST        "true" sends a test message (used by the manual "Run workflow" button)
//   STATE_FILE        default state.json (remembers the last alert so it is not sent twice)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { code } from "./detect.mjs";

const env = process.env;
const STATE_FILE = env.STATE_FILE || "state.json";
const now = env.NOW_MS ? Number(env.NOW_MS) : Date.now();

// Gold is closed from about Friday 21:00 UTC to Sunday 22:00 UTC.
function marketClosed(t) {
  const d = new Date(t);
  const dow = d.getUTCDay();
  const h = d.getUTCHours();
  return (dow === 5 && h >= 21) || dow === 6 || (dow === 0 && h < 22);
}

function warn(msg) {
  console.log(`::warning::${msg}`);
}

async function getCandles(interval, size) {
  const url =
    `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${interval}` +
    `&outputsize=${size}&timezone=UTC&apikey=${encodeURIComponent(env.TWELVE_DATA_KEY)}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status === "error" || !Array.isArray(body.values)) {
    throw new Error(`Twelve Data ${interval}: ${body.message || res.status}`);
  }
  return body.values;
}

async function sendTelegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    throw new Error(`Telegram rejected the message: ${body.description || res.status}`);
  }
}

function readState() {
  try {
    return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
  } catch (e) {
    return {};
  }
}

async function main() {
  for (const k of ["TWELVE_DATA_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) {
    if (!env[k]) {
      console.error(`Missing secret: ${k}`);
      process.exit(1);
    }
  }

  const force = String(env.FORCE_TEST || "").toLowerCase() === "true";

  if (!force && marketClosed(now)) {
    console.log("Market closed (weekend). Nothing to do, no API calls made.");
    return;
  }

  let m5;
  let h1;
  try {
    m5 = await getCandles("5min", 800);
    h1 = await getCandles("1h", 300);
  } catch (e) {
    // A data hiccup should not spam failure emails every 5 minutes.
    warn(String(e.message));
    console.log("Skipping this run.");
    return;
  }

  const result = await code({
    nowMs: now,
    m5,
    h1,
    levels: env.LEVELS || "",
    roundStep: env.ROUND_STEP || 50,
    atrBuffer: env.ATR_BUFFER || 0.25,
    trendFilter: env.TREND_FILTER || "off",
    forceTest: force ? "true" : "false",
  });

  console.log(`signal=${result.signal} reason=${result.reason || ""}`);
  if (result.signal !== "alert") return;

  const state = readState();
  if (!force && state.lastKey === result.alertKey) {
    console.log("Same alert as last time, not sending again.");
    return;
  }

  await sendTelegram(result.message);
  console.log("Telegram message sent.");

  if (!force) writeFileSync(STATE_FILE, JSON.stringify({ lastKey: result.alertKey, at: new Date(now).toISOString() }));
}

main().catch((e) => {
  console.error(String(e.message || e));
  process.exit(1);
});
