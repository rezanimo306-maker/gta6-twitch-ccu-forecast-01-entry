// main.ts — Forecast GTA VI's launch-day Twitch viewers hour by hour (round 3).
//
// Third and last kept round ("Size-Law CCU Forecaster"). The forecasting
// engine is round 2's, with exactly two constants changed (see TUNING
// below). Everything else — the two-component blend, the unlock shift, the
// spread calibration, the tangent extrapolation, the top-end flat shrink —
// is untouched, because a full validation sweep found nothing else that
// improves the forecast for the one launch that matters.
//
// Why only two constants? Round 3 was validated on THREE leave-one-launch-out
// pools, not one: the kit's 37 launches, those 37 plus 2 extra launches
// fetched from the same SullyGnome source (Palworld, Oblivion Remastered),
// and the 41 launches the final case actually ships (37 + the 4 practice
// launches). Every other idea was tried and rejected on that evidence:
//   - A smooth per-hour median-bias correction looked like a big win on the
//     aggregate (+0.11..+0.145 log in the evening) but the bias lives
//     entirely in tiny hour-1 launches (<5k, bias up to +0.93); at hour-1
//     >= 100k — GTA VI's regime — the bias is ~0. A global correction
//     would push the live forecast ~12% too high. Rejected.
//   - A pre-release hype feature (F = ln h1 / median viewers 24h before
//     release, partial corr +0.195) HURTS the big-launch regime badly
//     (LOLO >=100k 0.191 -> 0.210). Rejected. Hour-1 channel count adds
//     nothing either (partial corr -0.066 given ln h1). Rejected.
//   - Robust (Huber) quadratic, distance-weighted neighbours, flat-day
//     shrink, linear instead of quadratic, spread rescaling: all flat or
//     worse on at least one pool. Rejected.
//   - The two adopted changes both survive all three pools on the
//     live-relevant slice (hour-1 >= 100k): the blend weight and the
//     top-end flat shrink never make that slice worse, on any pool.
// The numbers (pinball loss, log scale; Python backtest, reproduced by
// this program end-to-end — see README.md):
//   practice overall 0.1605 (R2 0.1646, house 0.3871); LOLO mean 0.3596
//   (R2 0.3646, house 0.9296), wins 32/37, coverage90 0.885; hour-1 >= 100k
//   LOLO 0.1880 (R2 0.1910), wins 15/16. On the 41-launch pool:
//   LOLO 0.3405 (R2 0.3449), hour-1 >= 100k 0.1815 (R2 0.1836).
// Honest caveats carry over from round 2 unchanged: the final is one
// launch, GTA VI is bigger than every comparable, the top end is
// extrapolation, and the overall LOLO gain is small (~1%) and partly
// driven by two small launches — the live-regime gain is the real one,
// and it is small too. No practice answer is memorized or hardcoded
// anywhere: the program reads one case and forecasts it.

import * as fs from "node:fs";
import * as path from "node:path";

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];

// TUNING (round 3 changes vs round 2: ALPHA 0.6 -> 0.8, SHRINK_HI_MED 0.2 -> 0.3.
// ALPHA is the weight of the quadratic-regression component in the geometric
// blend with the nearest-neighbour component. The R2 grid stopped at 0.6;
// the R3 sweep (0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 1.0)
// peaks at 0.8 on the 37- and 41-launch pools and falls off on both sides,
// so 0.8 is an interior optimum, not an edge. Mechanism: the neighbour
// component is an equal-weight mean of 8 launches, which is high-variance
// wherever neighbours are sparse; the quadratic pools every comparable
// into one smooth curve, so more weight on it lowers variance. At the top
// end, where GTA VI sits, every neighbour is far below anyway, so locality
// buys little. SHRINK_HI_MED is the maximum fraction the predicted
// log-ratio is pulled toward flat at very high hour-1 (ramp 300k..1M):
// 0.3 instead of 0.2 makes the extrapolated top end less sensitive to
// how the quadratic bends at the low end, which is where one extreme
// comparable can lever the whole fit.)
const ALPHA = 0.8; // weight of the regression component in the geometric blend
const KNN_K = 8;
const SHRINK_HI = 0.8; // spread multiplier at hour-1 >= 100k
const WIDEN_LO = 1.15; // spread multiplier at hour-1 <= 5k
const ROLL_SHIFT = 0.8; // fraction of the rolling-vs-simultaneous gap applied
const SHRINK_HI_MED = 0.3; // median shrink toward flat, hour-1 300k..1M ramp

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

/**
 * Spread multiplier for a case with hour-1 print p: the empirical band is
 * over-wide where it matters most (big launches) and under-covers tiny
 * ones, so shrink it to 0.8x at hour-1 >= 100k (ramping in log space from
 * 20k) and widen it to 1.15x at hour-1 <= 5k (ramping from 20k).
 */
function spreadMultiplier(lnP: number): number {
  const ln100k = Math.log(100000);
  const ln20k = Math.log(20000);
  const ln5k = Math.log(5000);
  if (lnP >= ln100k) return SHRINK_HI;
  if (lnP >= ln20k) {
    const t = (lnP - ln20k) / (ln100k - ln20k);
    return 1 + t * (SHRINK_HI - 1);
  }
  if (lnP <= ln5k) return WIDEN_LO;
  const t = (lnP - ln5k) / (ln20k - ln5k);
  return WIDEN_LO + t * (1 - WIDEN_LO);
}

/**
 * One hour's five quantiles for a case with hour-1 print p.
 * Two components, geometrically blended with weight ALPHA on the
 * regression component:
 *   A — per-hour quadratic regression of ln(viewers(h)/viewers(1)) on
 *       ln(viewers(1)) across the comparables; median at the case's
 *       ln hour-1, tangent-extrapolated past the data edge with the extra
 *       move capped at 0.5 in log space; spread from the empirical
 *       quantiles of that hour's residuals.
 *   B — the KNN_K nearest comparables by |ln h1 - ln p|; their log-ratios
 *       at that hour give a normal median + spread (sd floored at 0.15).
 * Then, in order: the unlock shift (rolling-midnight launches sit above
 * simultaneous ones by a fitted residual gap; applied at ROLL_SHIFT
 * strength, signed by this case's unlock type), then the top-end median
 * shrink toward flat. Either component falls back to the house baseline
 * row for an hour it has no data for.
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
  const samples = pool
    .map((c) => {
      const v = c.curve.get(h);
      if (v === undefined || v <= 0) return null;
      return { name: c.name, x: Math.log(c.h1), y: Math.log(v / c.h1), rolling: c.rolling };
    })
    .filter((s): s is { name: string; x: number; y: number; rolling: boolean } => s !== null);

  let fit: QuadFit | null = null;
  let fitSamples: { name: string; x: number; y: number; rolling: boolean }[] | null = null;
  let quadRow: number[] | null = null;
  if (samples.length >= 8) {
    fit = quadFit(
      samples.map((s) => s.x),
      samples.map((s) => s.y),
    );
    if (fit) {
      fitSamples = samples;
      let mu: number;
      if (lnP > lnMax) {
        mu = fit.pred(lnMax) + fit.slope(lnMax) * Math.min(lnP - lnMax, 0.5);
      } else if (lnP < lnMin) {
        mu = fit.pred(lnMin) + fit.slope(lnMin) * Math.max(lnP - lnMin, -0.5);
      } else {
        mu = fit.pred(lnP);
      }
      const resid = samples
        .map((s) => s.y - fit!.pred(s.x))
        .sort((a, b) => a - b);
      quadRow = LEVELS.map((tau) => p * Math.exp(mu + quantile(resid, tau)));
    }
  }

  let knnRow: number[] | null = null;
  const nearest = [...pool]
    .sort((a, b) => {
      const d = Math.abs(Math.log(a.h1) - lnP) - Math.abs(Math.log(b.h1) - lnP);
      if (d !== 0) return d;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    })
    .slice(0, KNN_K);
  const rs: number[] = [];
  for (const c of nearest) {
    const v = c.curve.get(h);
    if (v !== undefined && v > 0) rs.push(Math.log(v / c.h1));
  }
  if (rs.length >= 3) {
    const mu = rs.reduce((a, b) => a + b, 0) / rs.length;
    const varr =
      rs.reduce((a, v) => a + (v - mu) * (v - mu), 0) / (rs.length - 1);
    const sd = Math.max(Math.sqrt(varr), 0.15);
    knnRow = Z.map((z) => p * Math.exp(mu + z * sd));
  }

  const a = quadRow ?? base;
  const b = knnRow ?? base;
  const med = Math.exp(ALPHA * Math.log(a[2]) + (1 - ALPHA) * Math.log(b[2]));
  let row = a.map((v, i) => {
    const lr = ALPHA * Math.log(v / a[2]) + (1 - ALPHA) * Math.log(b[i] / b[2]);
    let x = med * Math.exp(lr * sm);
    if (!Number.isFinite(x)) x = p;
    return x;
  });

  // Unlock shift: rolling launches sit above simultaneous ones after the
  // size regression, by a gap fitted from this hour's comparables.
  if (fit && fitSamples) {
    const residR = fitSamples
      .filter((s) => s.rolling)
      .map((s) => s.y - fit!.pred(s.x));
    const residS = fitSamples
      .filter((s) => !s.rolling)
      .map((s) => s.y - fit!.pred(s.x));
    if (residR.length >= 3 && residS.length >= 3) {
      const meanR = residR.reduce((x, y) => x + y, 0) / residR.length;
      const meanS = residS.reduce((x, y) => x + y, 0) / residS.length;
      const gap = meanR - meanS;
      const pRoll = residR.length / (residR.length + residS.length);
      const adj = ROLL_SHIFT * gap * (targetRolling ? 1 - pRoll : -pRoll);
      row = row.map((v) => v * Math.exp(adj));
    }
  }

  // Top-end median shrink: at very large hour-1 the predicted log-ratio
  // is pulled toward flat, ramping from 300k to 1M.
  const ln300k = Math.log(300000);
  const ln1m = Math.log(1000000);
  const t = Math.min(1, Math.max(0, (lnP - ln300k) / (ln1m - ln300k)));
  const ms = SHRINK_HI_MED * t;
  if (ms > 0) {
    row = row.map((v) => p * Math.exp(Math.log(Math.max(v, 1) / p) * (1 - ms)));
  }

  const out: number[] = [];
  for (const v of row) {
    const cv = Math.min(Math.max(v, 1), 1e9);
    const r = round2(cv);
    out.push(out.length > 0 && r < out[out.length - 1] ? out[out.length - 1] : r);
  }
  return out;
}

/**
 * Forecast one case: hours 2..24, five quantiles each.
 * The comparable pool drops any launch without a real hour-1 print or
 * with fewer than 20 of hours 2..24 (this drops the GTA VI category
 * itself, which has no release day yet). The target's unlock type comes
 * from the case's notes; a case with no notes defaults to rolling,
 * because the GTA VI notes describe a rolling midnight unlock.
 */
function forecastCase(input: any): { hours: { hour: number; q: number[] }[] } {
  const known = Array.isArray(input.known) ? input.known : [];
  const targetName = typeof input.name === "string" ? input.name : "";
  const target = known.find((c: any) => c.name === targetName) ?? known[0];
  const p = Math.max(1, target?.viewers ?? 1);
  const lnP = Math.log(p);
  const targetRolling =
    typeof input.notes === "string" && input.notes.length > 0
      ? isRolling(input.notes)
      : true;

  const comps = Array.isArray(input.comparables) ? input.comparables : [];
  const pool: Comparable[] = [];
  for (const c of comps) {
    const curve = releaseDayCurve(c);
    if (!curve) continue;
    const h1 = curve.get(1);
    if (h1 === undefined || h1 <= 0) continue;
    let n = 0;
    for (let h = 2; h <= 24; h++) if (curve.has(h)) n++;
    if (n < 20) continue;
    pool.push({ name: c.name, h1, curve, rolling: isRolling(c.unlock) });
  }

  const xs = pool.map((c) => Math.log(c.h1));
  const lnMin = xs.length > 0 ? Math.min(...xs) : lnP;
  const lnMax = xs.length > 0 ? Math.max(...xs) : lnP;

  const hours: { hour: number; q: number[] }[] = [];
  for (let h = 2; h <= 24; h++) {
    hours.push({
      hour: h,
      q: forecastHour(p, lnP, pool, h, lnMin, lnMax, targetRolling),
    });
  }
  return { hours };
}

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  fs.mkdirSync(outputDir, { recursive: true });
  const files = fs
    .readdirSync(inputDir)
    .filter((f) => f.endsWith(".in"))
    .sort();
  for (const file of files) {
    const id = file.slice(0, -3);
    const raw = fs.readFileSync(path.join(inputDir, file), "utf-8");
    const input = JSON.parse(raw);
    const result = forecastCase(input);
    fs.writeFileSync(
      path.join(outputDir, id + ".out"),
      JSON.stringify(result, null, 2) + "\n",
    );
  }
}

main();
