// Activepieces "Code" step, v2: XAU/USD alerts on the 5m chart.
//
// Alerts fire on:
//   1) BREAKS: a 5m candle closes beyond a level (ATR buffer applied).
//      Levels = your manual levels + automatic levels from 1H data
//      (previous day high/low, previous week high/low, latest 1H swing highs/lows)
//      + round numbers (+ optional rolling 5m swing).
//   2) ORDER BLOCK RETESTS: price returns for the FIRST time to a fresh 5m order block.
//
// Inputs (all optional except m5):
//   m5                 -> the "values" list from the 5m Twelve Data call (use outputsize=800 so it still has
//                         enough candles right after the weekend)
//   h1                 -> the "values" list from the 1H Twelve Data call (use outputsize=300)
//   levels             -> extra manual levels, comma separated, e.g. "4150, 4200"
//   roundStep          -> round-number spacing (default 50, 0 = off)
//   atrBuffer          -> a break must close this many ATRs beyond the level (default 0.25)
//   minAtr             -> ignore everything if 5m ATR is below this (default 0 = off)
//   useRollingSwing    -> also use the rolling 5m swing high/low as levels (default false)
//   lookback           -> candles for the rolling swing (default 20)
//   h1Swings           -> how many latest 1H swing highs and lows to use (default 2)
//   enableBreaks       -> true/false (default true)
//   enableOB           -> true/false (default true)
//   obImpulseAtr       -> the move away from the block must be at least this many ATRs (default 1.5)
//   obLookback         -> the move must also close beyond the high/low of this many candles before the block (default 10)
//   obMaxImpulseBars   -> the move must happen within this many candles after the block (default 3)
//   obMaxAgeBars       -> ignore blocks older than this many 5m candles (default 120 = 10 hours)
//   obMaxZoneAtr       -> ignore blocks wider than this many ATRs (default 3)
//   obUseBody          -> true = zone is the candle body, false = whole candle high-low (default false)
//   trendFilter        -> "off" (default) or "h1": only alert order-block retests that agree with the 1H trend
//   sessionShift       -> hours added to UTC to place the daily/weekly roll (default 3)
//   displayOffsetHours -> hours added to UTC for times in the message (default 5 = Pakistan)
//   skipWeekend        -> true (default): ignore candles and runs while gold is closed (Fri 21:00 - Sun 22:00 UTC)
//   forceTest          -> true = always return a test alert (to test the Telegram part). Turn off afterwards!
//
// Outputs: signal ("alert" or "none"), message (ready to send), alertKey (use for the duplicate guard),
//          plus alertType, direction, price, candleTime, atr, alerts, h1Trend, reason.

export const code = async (inputs) => {
  const num = (v, d) => (v === undefined || v === null || v === "" || isNaN(Number(v)) ? d : Number(v));
  const bool = (v, d) =>
    v === undefined || v === null || v === "" ? d : !["false", "0", "no", "off"].includes(String(v).trim().toLowerCase());

  const cfg = {
    atrBuffer: num(inputs.atrBuffer, 0.25),
    minAtr: num(inputs.minAtr, 0),
    roundStep: num(inputs.roundStep, 50),
    useRollingSwing: bool(inputs.useRollingSwing, false),
    lookback: num(inputs.lookback, 20),
    h1Swings: num(inputs.h1Swings, 2),
    enableBreaks: bool(inputs.enableBreaks, true),
    enableOB: bool(inputs.enableOB, true),
    obImpulseAtr: num(inputs.obImpulseAtr, 1.5),
    obLookback: num(inputs.obLookback, 10),
    obMaxImpulseBars: num(inputs.obMaxImpulseBars, 3),
    obMaxAgeBars: num(inputs.obMaxAgeBars, 120),
    obMaxZoneAtr: num(inputs.obMaxZoneAtr, 3),
    obUseBody: bool(inputs.obUseBody, false),
    trendFilter: String(inputs.trendFilter || "off").trim().toLowerCase(),
    sessionShift: num(inputs.sessionShift, 3),
    displayOffset: num(inputs.displayOffsetHours, 5),
    skipWeekend: bool(inputs.skipWeekend, true),
  };
  // Gold is closed from about Friday 21:00 UTC to Sunday 22:00 UTC. The data feed still sends flat
  // candles in that window, so they are ignored (otherwise they create fake daily levels and alerts).
  const isClosed = (t) => {
    const d = new Date(t);
    const dow = d.getUTCDay();
    const h = d.getUTCHours();
    return (dow === 5 && h >= 21) || dow === 6 || (dow === 0 && h < 22);
  };
  const now = inputs.nowMs ? Number(inputs.nowMs) : Date.now();
  const manual = String(inputs.levels || "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => n > 0);

  const toArr = (raw) => {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === "string") {
      try {
        const p = JSON.parse(raw);
        return Array.isArray(p) ? p : [];
      } catch (e) {
        return [];
      }
    }
    return [];
  };

  // Candles oldest first; the one still forming is dropped. Call the API with timezone=UTC.
  const prep = (raw, mins) =>
    toArr(raw)
      .map((x) => ({
        t: Date.parse(String(x.datetime).replace(" ", "T") + "Z"),
        o: +x.open,
        h: +x.high,
        l: +x.low,
        c: +x.close,
      }))
      .filter((x) => !isNaN(x.t) && !isNaN(x.c))
      .filter((x) => !(cfg.skipWeekend && isClosed(x.t)))
      .sort((a, b) => a.t - b.t)
      .filter((x) => x.t + mins * 60000 <= now);

  const atrSeries = (c, n = 14) => {
    const tr = c.map((x, i) =>
      i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))
    );
    return c.map((_, i) => {
      if (i < 1) return tr[0];
      const from = Math.max(1, i - n + 1);
      let s = 0;
      for (let k = from; k <= i; k++) s += tr[k];
      return s / (i - from + 1);
    });
  };

  const ema = (vals, n = 20) => {
    const k = 2 / (n + 1);
    const out = [];
    vals.forEach((v, i) => out.push(i === 0 ? v : v * k + out[i - 1] * (1 - k)));
    return out;
  };
  const bias = (c) => {
    if (c.length < 25) return "n/a";
    const e = ema(c.map((x) => x.c), 20);
    const lastE = e[e.length - 1];
    const before = e[e.length - 4];
    const px = c[c.length - 1].c;
    if (px > lastE && lastE > before) return "up";
    if (px < lastE && lastE < before) return "down";
    return "flat";
  };

  const f2 = (v) => Number(v).toFixed(2);
  const fmtT = (t) => {
    const d = new Date(t + cfg.displayOffset * 3600000);
    const sign = cfg.displayOffset >= 0 ? "+" : "";
    return d.toISOString().slice(0, 16).replace("T", " ") + " (UTC" + sign + cfg.displayOffset + ")";
  };
  const none = (reason, extra = {}) => ({ signal: "none", reason, ...extra });

  const m5 = prep(inputs.m5, 5);
  const h1 = prep(inputs.h1, 60);

  if (bool(inputs.forceTest, false)) {
    const p = m5.length ? m5[m5.length - 1] : null;
    return {
      signal: "alert",
      alertType: "test",
      alertKey: "test|" + now,
      message: "TEST ALERT: your gold alert flow is working." + (p ? "\nLast 5m close: " + f2(p.c) : ""),
      price: p ? p.c : null,
      candleTime: p ? new Date(p.t).toISOString() : null,
    };
  }

  if (cfg.skipWeekend && isClosed(now)) return none("market closed (weekend)");

  if (m5.length < Math.max(cfg.lookback, cfg.obLookback) + 20) return none("not enough 5m candles (use outputsize=800)");

  const n = m5.length;
  const last = m5[n - 1];
  const prev = m5[n - 2];
  const atrArr = atrSeries(m5);
  const atr = atrArr[n - 1];
  const buffer = cfg.atrBuffer * atr;
  const h1Trend = bias(h1);

  const base = {
    price: last.c,
    candleTime: new Date(last.t).toISOString(),
    atr: Math.round(atr * 100) / 100,
    h1Trend,
  };

  if (atr < cfg.minAtr) return none("5m ATR below minimum (low volatility)", base);

  const alerts = [];

  // ---------------- 1) BREAKS ----------------
  if (cfg.enableBreaks) {
    const levelMap = new Map();
    const addLevel = (level, kind) => {
      if (!(level > 0)) return;
      const k = level.toFixed(2);
      if (!levelMap.has(k)) levelMap.set(k, { level, kind });
    };

    manual.forEach((l) => addLevel(l, "key level"));

    // Automatic levels from 1H data
    if (h1.length) {
      const shift = cfg.sessionShift * 3600000;
      const dayKey = (t) => new Date(t + shift).toISOString().slice(0, 10);
      const weekKey = (t) => {
        const d = new Date(t + shift);
        const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
        return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow)).toISOString().slice(0, 10);
      };
      const group = (keyFn) => {
        const g = {};
        h1.forEach((x) => {
          const k = keyFn(x.t);
          if (!g[k]) g[k] = { n: 0, hi: -Infinity, lo: Infinity };
          g[k].n++;
          g[k].hi = Math.max(g[k].hi, x.h);
          g[k].lo = Math.min(g[k].lo, x.l);
        });
        return g;
      };
      const pickPrev = (g, currentKey, minCount) => {
        const ks = Object.keys(g)
          .filter((k) => k < currentKey && g[k].n >= minCount)
          .sort();
        return ks.length ? g[ks[ks.length - 1]] : null;
      };
      const pd = pickPrev(group(dayKey), dayKey(now), 8);
      const pw = pickPrev(group(weekKey), weekKey(now), 30);
      if (pd) {
        addLevel(pd.hi, "previous day high");
        addLevel(pd.lo, "previous day low");
      }
      if (pw) {
        addLevel(pw.hi, "previous week high");
        addLevel(pw.lo, "previous week low");
      }

      // Latest 1H swing highs / lows (3 candles each side)
      const K = 3;
      const hi = [];
      const lo = [];
      for (let i = K; i < h1.length - K; i++) {
        let isH = true;
        let isL = true;
        for (let q = 1; q <= K; q++) {
          if (!(h1[i].h > h1[i - q].h && h1[i].h > h1[i + q].h)) isH = false;
          if (!(h1[i].l < h1[i - q].l && h1[i].l < h1[i + q].l)) isL = false;
        }
        if (isH) hi.push(h1[i].h);
        if (isL) lo.push(h1[i].l);
      }
      hi.slice(-cfg.h1Swings).forEach((v) => addLevel(v, "1H swing high"));
      lo.slice(-cfg.h1Swings).forEach((v) => addLevel(v, "1H swing low"));
    }

    // Round numbers near price
    if (cfg.roundStep > 0) {
      const lo = Math.min(prev.c, last.c) - cfg.roundStep;
      const hi = Math.max(prev.c, last.c) + cfg.roundStep;
      for (let L = Math.ceil(lo / cfg.roundStep) * cfg.roundStep; L <= hi; L += cfg.roundStep) addLevel(L, "round number");
    }

    // Optional rolling 5m swing
    if (cfg.useRollingSwing) {
      const win = m5.slice(-(cfg.lookback + 1), -1);
      addLevel(Math.max(...win.map((x) => x.h)), "5m swing high");
      addLevel(Math.min(...win.map((x) => x.l)), "5m swing low");
    }

    const up = [];
    const down = [];
    levelMap.forEach((lv) => {
      if (prev.c <= lv.level && last.c > lv.level + buffer) up.push(lv);
      else if (prev.c >= lv.level && last.c < lv.level - buffer) down.push(lv);
    });
    [[up, "breakout"], [down, "breakdown"]].forEach(([list, type]) => {
      if (!list.length) return;
      const names = list.map((l) => l.kind + " " + f2(l.level)).join(", ");
      alerts.push({
        type,
        id: type + "|" + list.map((l) => f2(l.level)).join(","),
        text:
          "XAU/USD " + type.toUpperCase() + " (5m)\nPrice: " + f2(last.c) + "\nBroke: " + names,
      });
    });
  }

  // ---------------- 2) ORDER BLOCK RETEST ----------------
  if (cfg.enableOB) {
    const lastIdx = n - 1;
    let best = null;
    for (let i = Math.max(cfg.obLookback, lastIdx - cfg.obMaxAgeBars); i <= lastIdx - 2; i++) {
      const k = m5[i];
      const nx = m5[i + 1];
      const a = atrArr[i];
      let hh = -Infinity;
      let ll = Infinity;
      for (let q = i - cfg.obLookback; q < i; q++) {
        hh = Math.max(hh, m5[q].h);
        ll = Math.min(ll, m5[q].l);
      }
      for (const dir of ["bullish", "bearish"]) {
        const isBull = dir === "bullish";
        // bullish block = last DOWN candle before an up-move; bearish block = last UP candle before a down-move
        if (isBull ? !(k.c < k.o && nx.c > nx.o) : !(k.c > k.o && nx.c < nx.o)) continue;
        let jOk = -1;
        for (let j = i + 1; j <= Math.min(i + cfg.obMaxImpulseBars, lastIdx - 1); j++) {
          const brk = isBull ? m5[j].c > hh : m5[j].c < ll;
          const size = isBull ? m5[j].c - k.h : k.l - m5[j].c;
          if (brk && size >= cfg.obImpulseAtr * a) {
            jOk = j;
            break;
          }
        }
        if (jOk < 0) continue;

        let top = k.h;
        let bottom = k.l;
        if (cfg.obUseBody) {
          top = Math.max(k.o, k.c);
          bottom = Math.min(k.o, k.c);
        }
        if (top - bottom > cfg.obMaxZoneAtr * a) continue;

        // first retest only: nothing may have touched the zone after the move
        let touched = false;
        for (let q = jOk + 1; q <= lastIdx - 1; q++) {
          if (isBull ? m5[q].l <= top : m5[q].h >= bottom) {
            touched = true;
            break;
          }
        }
        if (touched) continue;

        // retest now: last candle enters the zone but does not close through it
        const retest = isBull ? last.l <= top && last.c >= bottom : last.h >= bottom && last.c <= top;
        if (!retest) continue;

        if (!best || i > best.i) best = { i, dir, top, bottom, t: k.t };
      }
    }

    if (best) {
      const agrees = best.dir === "bullish" ? h1Trend === "up" : h1Trend === "down";
      const blocked = cfg.trendFilter === "h1" && !agrees;
      if (!blocked) {
        alerts.push({
          type: "ob_" + best.dir,
          id: "ob-" + best.dir + "|" + f2(best.bottom) + "-" + f2(best.top),
          text:
            "XAU/USD " + best.dir.toUpperCase() + " ORDER BLOCK RETEST (5m)\nPrice: " + f2(last.c) +
            "\nZone: " + f2(best.bottom) + " - " + f2(best.top) +
            "\nBlock formed: " + fmtT(best.t),
        });
      }
    }
  }

  if (!alerts.length) return none("no break or order block retest on the last closed 5m candle", base);

  const main = alerts[0];
  const message = alerts.map((x) => x.text).join("\n\n") + "\n\n1H trend: " + h1Trend + "\nCandle: " + fmtT(last.t);
  return {
    signal: "alert",
    reason: "alert",
    alertType: alerts.map((x) => x.type).join("+"),
    direction: main.type.indexOf("bull") >= 0 || main.type === "breakout" ? "bullish" : "bearish",
    alertKey: base.candleTime + "|" + alerts.map((x) => x.id).join(";"),
    message,
    alerts: alerts.map((x) => ({ type: x.type, id: x.id })),
    ...base,
  };
};
