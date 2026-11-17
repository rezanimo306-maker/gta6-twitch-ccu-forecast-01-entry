// main.ts — Forecast GTA VI's launch-day Twitch viewers hour by hour.
//
// Approach (validated by leave-one-launch-out over 37 past launches + the
// 4 practice cases; see README.md for the numbers):
//   The launch-day audience curve is NOT one shape: how much Twitch
//   viewership grows after hour 1 depends overwhelmingly on how big hour 1
//   already is. A launch whose hour-1 print is tiny (a few hundred viewers
//   — almost nobody unlocked yet at 00:00 UTC) can grow 100-2000x by the
//   evening; a launch whose hour 1 is already ~500k (most of the world
//   unlocked, PC + consoles) stays flat or decays. So every forecast is
//   conditioned on ln(hour-1 print):
//     A) per hour, a quadratic regression of ln(viewers(h)/viewers(1)) on
//        ln(viewers(1)) across the case's comparables, with empirical
//        residual quantiles for the spread (captures the smooth size law);
//     B) the 8 nearest comparables by |ln h1 - ln p1|, normal quantiles
//        from their log-ratios (anchors on launches actually similar in
//        size to this one);
//   The forecast is the geometric mean of A and B per quantile. If either
//   component lacks data for an hour it falls back to the house baseline
//   shape for that hour. Pure function of the input case: no clock, no
//   network, no randomness, no model calls. Deterministic byte-identical
//   outputs across runs.

import * as fs from "node:fs";
import * as path from "node:path";

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];

interface Comparable {
  name: string;
  h1: number;
  curve: Map<number, number>; // release-day UTC hour (1..24) -> mean viewers
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

/**
 * Least-squares quadratic fit y ~ c0 + c1*(x-mx) + c2*(x-mx)^2, solved by
 * Gaussian elimination with partial pivoting. Returns null when there are
 * too few points or the system is singular.
 */
function quadFit(xs: number[], ys: number[]): ((x: number) => number) | null {
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
  return (x: number) => c[0] + c[1] * (x - mx) + c[2] * (x - mx) * (x - mx);
}

/**
 * Forecast one hour h (2..24) as five quantiles.
 * Component A: quadratic regression of ln(v(h)/v(1)) on ln(v(1)) over the
 *   comparables that have hour h, median predicted at the case's ln(p1)
 *   (clamped to the comparables' observed ln h1 range — never extrapolate
 *   past the data), spread from the empirical quantiles of that hour's
 *   residuals.
 * Component B: the 8 nearest comparables by |ln h1 - ln p1|; their
 *   log-ratios at hour h give a normal median + spread (sd floored at
 *   0.15 so the band never collapses on a few agreeing neighbours).
 * Blend: geometric mean of A and B per level. A component that lacks data
 * for the hour falls back to the house baseline row.
 */
function forecastHour(
  p: number,
  lnP: number,
  pool: Comparable[],
  h: number,
  lnMin: number,
  lnMax: number,
): number[] {
  const base = houseRow(p, h);

  let qA: number[] | null = null;
  const pts: { x: number; r: number }[] = [];
  for (const c of pool) {
    const v = c.curve.get(h);
    if (v !== undefined && v > 0) {
      pts.push({ x: Math.log(c.h1), r: Math.log(v / c.h1) });
    }
  }
  if (pts.length >= 8) {
    const xs = pts.map((q) => q.x);
    const ys = pts.map((q) => q.r);
    const pred = quadFit(xs, ys);
    if (pred !== null) {
      const xq = Math.min(Math.max(lnP, lnMin), lnMax);
      const mu = pred(xq);
      const resid = ys.map((y, i) => y - pred(xs[i])).sort((a, b) => a - b);
      qA = LEVELS.map((tau) => p * Math.exp(mu + quantile(resid, tau)));
    }
  }

  let qB: number[] | null = null;
  const knn = [...pool]
    .sort((a, b) => {
      const d = Math.abs(Math.log(a.h1) - lnP) - Math.abs(Math.log(b.h1) - lnP);
      if (d !== 0) return d;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    })
    .slice(0, 8);
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
  let prev = 0;
  return a.map((v, i) => {
    let x = Math.sqrt(v * b[i]);
    if (!Number.isFinite(x)) x = p;
    x = Math.min(Math.max(x, 1), 1e9);
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
    pool.push({ name: String(comp.name ?? ""), h1, curve });
  }
  const lnH1 = pool.map((x) => Math.log(x.h1));
  const lnMin = lnH1.length > 0 ? Math.min(...lnH1) : lnP;
  const lnMax = lnH1.length > 0 ? Math.max(...lnH1) : lnP;

  const hours = [];
  for (let h = 2; h <= 24; h++) {
    hours.push({ hour: h, q: forecastHour(p, lnP, pool, h, lnMin, lnMax) });
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
