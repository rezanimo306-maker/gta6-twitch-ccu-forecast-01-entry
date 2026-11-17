// main.ts — Forecast GTA VI's launch-day Twitch viewers hour by hour (round 2).
//
// Revision of round 1 ("Size-Law CCU Forecaster"). Same two-component core,
// plus four changes, each validated by leave-one-launch-out over 37 past
// launches + the 4 practice cases (see README.md for the numbers):
//   1) Rolling-midnight unlock shift. Launches that unlock at local midnight
//      in each timezone ramp harder through the day than simultaneous-global
//      unlocks at the same hour-1 size: after the size regression, rolling
//      launches sit ~0.3 log units above simultaneous ones in the evening
//      (partial correlation +0.34 given ln hour-1). So each hour's forecast
//      is shifted by 80% of the rolling-vs-simultaneous residual gap,
//      signed by whether THIS case's unlock is rolling (read from the case's
//      notes; GTA VI unlocks at rolling midnight local).
//   2) Tighter spread where the band was over-wide. Practice coverage was
//      1.000 on 3 of 4 cases and LOLO coverage 0.97 at hour-1 >= 50k, so the
//      spread is shrunk to 0.8x at hour-1 >= 100k (ramping in log space
//      from 20k) and widened to 1.15x at hour-1 <= 5k (where coverage was
//      0.81, slightly under-covered).
//   3) Tangent extrapolation past the data edge. Round 1 clamped the
//      regression to the largest observed hour-1 (~875k); GTA VI's hour-1
//      may exceed that, so beyond the edge the forecast now follows the
//      regression's local slope, with the extra move capped at 0.5 in log
//      space. The slope at the top edge is small and negative (bigger
//      launches grow less), so this is a gentle, safe extension.
//   4) Median shrink toward flat at very high hour-1 (300k..1M ramp, 20%):
//      the biggest launches' evenings are flatter than the size law alone
//      predicts.
// The blend now weights the regression component 0.6 / neighbours 0.4
// (was 0.5/0.5). Pure function of the input case: no clock, no network, no
// randomness, no model calls. Deterministic byte-identical outputs.

import * as fs from "node:fs";
import * as path from "node:path";

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];

// Round-2 tuning (see README.md for the validation table).
const ALPHA = 0.6; // weight of the regression component in the geometric blend
const KNN_K = 8;
const SHRINK_HI = 0.8; // spread multiplier at hour-1 >= 100k
const WIDEN_LO = 1.15; // spread multiplier at hour-1 <= 5k
const ROLL_SHIFT = 0.8; // fraction of the rolling-vs-simultaneous gap applied
const SHRINK_HI_MED = 0.2; // median shrink toward flat, hour-1 300k..1M ramp

interface Comparable {
  name: string;
  h1: number;
  curve: Map<number, number>; // release-day UTC hour (1..24) -> mean viewers
  rolling: boolean; // rolling-midnight unlock (vs simultaneous global unlock)
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Linear-interpolated quantile of a sorted array (same convention as the backtest). */
function quantile(sorted: number[], tau: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const pos = tau * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - pos) + sorted[hi] * (pos - lo);
}

/** House baseline row: every hour stays at p, spread widening over the day. */
function houseRow(p: number, h: number): number[] {
  return Z.map((z) => round2(p * Math.exp(z * 0.15 * Math.sqrt(h - 1))));
}

/** A comparable's release-day hourly curve: mean of the points in each UTC hour of day_start. */
function releaseDayCurve(comp: any): Map<number, number> | null {
  const ds = Date.parse(comp.day_start);
  if (!Number.isFinite(ds)) return null;
  const sums = new Map<number, { s: number; n: number }>();
  const hourly = Array.isArray(comp.hourly) ? comp.hourly : [];
  for (const pt of hourly) {
    if (typeof pt.viewers !== "number" || pt.viewers < 0) continue;
    const t = Date.parse(pt.from);
    if (!Number.isFinite(t)) continue;
    const h = Math.floor((t - ds) / 3600000) + 1;
    if (h < 1 || h > 24) continue;
    const e = sums.get(h) ?? { s: 0, n: 0 };
    e.s += pt.viewers;
    e.n += 1;
    sums.set(h, e);
  }
  const curve = new Map<number, number>();
  for (const [h, e] of sums) curve.set(h, e.s / e.n);
  return curve;
}

/** Rolling-midnight unlock? The unlock text says "rolling" or "midnight local". */
function isRolling(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const t = text.toLowerCase();
  return t.includes("rolling") || t.includes("midnight local");
}

interface QuadFit {
  pred: (x: number) => number;
  slope: (x: number) => number;
  mx: number;
}

/**
 * Least-squares quadratic fit y ~ c0 + c1*(x-mx) + c2*(x-mx)^2, solved by
 * Gaussian elimination with partial pivoting. Returns null when there are
 * too few points or the system is singular.
 */
function quadFit(xs: number[], ys: number[]): QuadFit | null {
  const n = xs.length;
  if (n < 8) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const xc = xs.map((x) => x - mx);
  const sumXc = xc.reduce((a, b) => a + b, 0);
  const s2 = xc.reduce((a, v) => a + v * v, 0);
  const s3 = xc.reduce((a, v) => a + v * v * v, 0);
  const s4 = xc.reduce((a, v) => a + v * v * v * v, 0);
  const u0 = ys.reduce((a, b) => a + b, 0);
  const u1 = xc.reduce((a, v, i) => a + v * ys[i], 0);
  const u2 = xc.reduce((a, v, i) => a + v * v * ys[i], 0);
  const a: number[][] = [
    [n, sumXc, s2, u0],
    [sumXc, s2, s3, u1],
    [s2, s3, s4, u2],
  ];
  for (let i = 0; i < 3; i++) {
    let piv = i;
    for (let r = i + 1; r < 3; r++) {
      if (Math.abs(a[r][i]) > Math.abs(a[piv][i])) piv = r;
    }
    const tmp = a[i];
    a[i] = a[piv];
    a[piv] = tmp;
    if (a[i][i] === 0) return null;
    for (let r = i + 1; r < 3; r++) {
      const f = a[r][i] / a[i][i];
      for (let cc = i; cc < 4; cc++) a[r][cc] -= f * a[i][cc];
    }
  }
  const c = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let s = a[i][3];
    for (let j = i + 1; j < 3; j++) s -= a[i][j] * c[j];
    c[i] = s / a[i][i];
  }
  if (!c.every(Number.isFinite)) return null;
  return {
    pred: (x: number) => c[0] + c[1] * (x - mx) + c[2] * (x - mx) * (x - mx),
    slope: (x: number) => c[1] + 2 * c[2] * (x - mx),
    mx,
  };
}

/** Spread multiplier: 1.15x at tiny hour-1, 1x mid-range, 0.8x at hour-1 >= 100k. */
function spreadMultiplier(lnP: number): number {
  const ln5k = Math.log(5000);
  const ln20k = Math.log(20000);
  const ln100k = Math.log(100000);
  if (lnP >= ln100k) return SHRINK_HI;
  if (lnP >= ln20k) {
    const t = (lnP - ln20k) / (ln100k - ln20k);
    return 1 + (SHRINK_HI - 1) * t;
  }
  if (lnP <= ln5k) return WIDEN_LO;
  const t = (lnP - ln5k) / (ln20k - ln5k);
  return WIDEN_LO + (1 - WIDEN_LO) * t;
}

/**
 * Forecast one hour h (2..24) as five quantiles.
 * Component A: quadratic regression of ln(v(h)/v(1)) on ln(v(1)) over the
 *   comparables that have hour h, median predicted at the case's ln(p1)
 *   (tangent-extrapolated past the data edge, extra move capped at 0.5 in
 *   log space), spread from the empirical quantiles of that hour's
 *   residuals.
 * Component B: the 8 nearest comparables by |ln h1 - ln p1|; their
 *   log-ratios at hour h give a normal median + spread (sd floored at
 *   0.15 so the band never collapses on a few agreeing neighbours).
 * Blend: geometric mean of A and B per level, weight 0.6 on A; the spread
 *   around the blended median is scaled by spreadMultiplier(lnP).
 * Then two median adjustments: the rolling-unlock shift (80% of the
 *   rolling-vs-simultaneous residual gap at this hour, signed by whether
 *   this case's unlock is rolling) and, at hour-1 >= 300k, a shrink of
 *   the log-ratio toward flat (0% at 300k, 20% at 1M).
 * A component that lacks data for the hour falls back to the house
 *   baseline row.
 */
function forecastHour(
  p: number,
  lnP: number,
  pool: Comparable[],
  h: number,
  lnMin: number,
  lnMax: number,
  targetRolling: boolean,
): number[] {
  const base = houseRow(p, h);
  const sm = spreadMultiplier(lnP);

  let qA: number[] | null = null;
  let gapFit: QuadFit | null = null;
  let gapPts: { x: number; r: number; rolling: boolean }[] = [];
  const pts: { x: number; r: number; rolling: boolean }[] = [];
  for (const c of pool) {
    const v = c.curve.get(h);
    if (v !== undefined && v > 0) {
      pts.push({ x: Math.log(c.h1), r: Math.log(v / c.h1), rolling: c.rolling });
    }
  }
  if (pts.length >= 8) {
    const xs = pts.map((q) => q.x);
    const ys = pts.map((q) => q.r);
    const fit = quadFit(xs, ys);
    if (fit !== null) {
      let mu: number;
      if (lnP > lnMax) {
        mu = fit.pred(lnMax) + fit.slope(lnMax) * Math.min(lnP - lnMax, 0.5);
      } else if (lnP < lnMin) {
        mu = fit.pred(lnMin) + fit.slope(lnMin) * Math.max(lnP - lnMin, -0.5);
      } else {
        mu = fit.pred(lnP);
      }
      const resid = ys.map((y, i) => y - fit.pred(xs[i])).sort((a, b) => a - b);
      qA = LEVELS.map((tau) => p * Math.exp(mu + quantile(resid, tau)));
      gapFit = fit;
      gapPts = pts;
    }
  }

  let qB: number[] | null = null;
  const knn = [...pool]
    .sort((a, b) => {
      const d = Math.abs(Math.log(a.h1) - lnP) - Math.abs(Math.log(b.h1) - lnP);
      if (d !== 0) return d;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    })
    .slice(0, KNN_K);
  const rs: number[] = [];
  for (const c of knn) {
    const v = c.curve.get(h);
    if (v !== undefined && v > 0) rs.push(Math.log(v / c.h1));
  }
  if (rs.length >= 3) {
    const mu = rs.reduce((a, b) => a + b, 0) / rs.length;
    const sd = Math.max(
      Math.sqrt(rs.reduce((a, v) => a + (v - mu) * (v - mu), 0) / (rs.length - 1)),
      0.15,
    );
    qB = Z.map((z) => p * Math.exp(mu + z * sd));
  }

  const a = qA ?? base;
  const b = qB ?? base;
  const med = Math.exp(ALPHA * Math.log(a[2]) + (1 - ALPHA) * Math.log(b[2]));
  let row = a.map((v, i) => {
    const lr = ALPHA * Math.log(a[i] / a[2]) + (1 - ALPHA) * Math.log(b[i] / b[2]);
    let x = med * Math.exp(lr * sm);
    if (!Number.isFinite(x)) x = p;
    return x;
  });

  // Rolling-unlock shift: rolling launches ramp harder than simultaneous
  // ones at the same hour-1 size. The gap is the mean quad residual of the
  // rolling comparables minus that of the simultaneous ones at this hour.
  if (gapFit !== null && gapPts.length >= 8) {
    const resR = gapPts.filter((q) => q.rolling).map((q) => q.r - gapFit!.pred(q.x));
    const resS = gapPts.filter((q) => !q.rolling).map((q) => q.r - gapFit!.pred(q.x));
    if (resR.length >= 3 && resS.length >= 3) {
      const gap =
        resR.reduce((s, v) => s + v, 0) / resR.length -
        resS.reduce((s, v) => s + v, 0) / resS.length;
      const pRoll = resR.length / (resR.length + resS.length);
      const adj = ROLL_SHIFT * gap * (targetRolling ? 1 - pRoll : -pRoll);
      row = row.map((v) => v * Math.exp(adj));
    }
  }

  // Median shrink toward flat at very high hour-1 (300k..1M ramp, up to 20%).
  const ln300k = Math.log(300000);
  const ln1m = Math.log(1000000);
  let t = 0;
  if (lnP > ln300k) t = lnP >= ln1m ? 1 : (lnP - ln300k) / (ln1m - ln300k);
  const ms = SHRINK_HI_MED * t;
  if (ms > 0) {
    row = row.map((v) => p * Math.exp(Math.log(Math.max(v, 1) / p) * (1 - ms)));
  }

  let prev = 0;
  return row.map((v) => {
    let x = Math.min(Math.max(v, 1), 1e9);
    x = round2(x);
    if (x < prev) x = prev; // keep quantiles non-decreasing
    prev = x;
    return x;
  });
}

/** Forecast one case: hours 2..24, five quantiles each. */
function forecastCase(c: any): { hours: { hour: number; q: number[] }[] } {
  const known = Array.isArray(c.known) ? c.known[0] : undefined;
  let p =
    known && typeof known.viewers === "number" && known.viewers > 0
      ? known.viewers
      : 1;
  if (!Number.isFinite(p) || p < 1) p = 1;
  const lnP = Math.log(p);

  // Rolling-midnight unlock? Read from the case notes; GTA VI unlocks at
  // rolling midnight local, so a case without notes defaults to rolling.
  const notes = (c as any).notes;
  const targetRolling =
    typeof notes === "string" && notes.length > 0 ? isRolling(notes) : true;

  // Comparable pool: needs a real hour-1 print and at least 20 of hours
  // 2..24 on its release day. This drops the GTA VI category itself (no
  // release day yet) and any sparse/unusable launch.
  const pool: Comparable[] = [];
  const comps = Array.isArray(c.comparables) ? c.comparables : [];
  for (const comp of comps) {
    const curve = releaseDayCurve(comp);
    if (!curve) continue;
    const h1 = curve.get(1);
    if (!h1 || h1 <= 0) continue;
    let nHours = 0;
    for (let h = 2; h <= 24; h++) if (curve.has(h)) nHours++;
    if (nHours < 20) continue;
    pool.push({ name: String(comp.name ?? ""), h1, curve, rolling: isRolling(comp.unlock) });
  }
  const lnH1 = pool.map((x) => Math.log(x.h1));
  const lnMin = lnH1.length > 0 ? Math.min(...lnH1) : lnP;
  const lnMax = lnH1.length > 0 ? Math.max(...lnH1) : lnP;

  const hours = [];
  for (let h = 2; h <= 24; h++) {
    hours.push({ hour: h, q: forecastHour(p, lnP, pool, h, lnMin, lnMax, targetRolling) });
  }
  return { hours };
}

function main(): void {
  const inDir = process.env.MAKEFUN_INPUT_DIR || "/input/";
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output/";
  fs.mkdirSync(outDir, { recursive: true });
  const files = fs
    .readdirSync(inDir)
    .filter((f) => f.endsWith(".in"))
    .sort();
  for (const f of files) {
    const id = f.slice(0, -3);
    const c = JSON.parse(fs.readFileSync(path.join(inDir, f), "utf8"));
    const out = forecastCase(c);
    fs.writeFileSync(path.join(outDir, `${id}.out`), JSON.stringify(out));
  }
}

main();
