[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![make.fun · gta6-twitch-ccu-forecast-01 rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/rezanimo306-maker/gta6-twitch-ccu-forecast-01-entry/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![make.fun · gta6-twitch-ccu-forecast-01 reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/rezanimo306-maker/gta6-twitch-ccu-forecast-01-entry/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

# GTA VI launch-day Twitch viewers — hour-by-hour forecast (round 3, final)

Entry for the make.fun bounty: https://make.fun/bounty/gta6-twitch-ccu-forecast-01

`main.ts` (Node 22, standard library only, no network, no model calls)
forecasts Twitch concurrent viewers in the Grand Theft Auto VI category for
each hour 2–24 of release day (2026-11-19 UTC), five quantiles each, from the
case's hour-1 print and the comparables (past big launches' release days)
shipped in the case file.

## How it works

Launch-day curves are not one shape: how much viewership grows after hour 1
depends overwhelmingly on how big hour 1 already is. A launch whose hour-1
print is tiny (a few hundred viewers — almost nobody unlocked yet at 00:00
UTC) can grow 100–2000x by the evening; a launch whose hour 1 is already
~500k stays flat or decays. So every hour's forecast is conditioned on
ln(hour-1 print), as the geometric mean of two components (weights 0.8 / 0.2
in this round):

- **A — quadratic regression.** Per hour, ln(viewers(h)/viewers(1)) regressed
  quadratically on ln(viewers(1)) across the case's comparables, median
  predicted at the case's ln(hour-1) (tangent-extrapolated past the data
  edge, extra move capped at 0.5 in log space), spread from the empirical
  quantiles of that hour's residuals.
- **B — 8 nearest neighbours.** The 8 comparables closest in |ln h1 − ln p1|;
  their log-ratios at that hour give a normal median + spread (sd floored
  at 0.15 so the band never collapses on a few agreeing neighbours).

Then three adjustments, all fitted on the comparables inside the case:

- **Unlock shift.** Launches that unlock at local midnight in each timezone
  ramp harder through the day than simultaneous-global unlocks at the same
  hour-1 size: after the size regression, rolling launches sit ~0.3 log
  units above simultaneous ones in the evening (partial correlation +0.34
  given ln hour-1). Each hour's forecast is shifted by 80% of that
  rolling-vs-simultaneous residual gap, signed by whether this case's
  unlock is rolling (read from the case's notes; GTA VI unlocks at rolling
  midnight local).
- **Spread calibration.** The spread is shrunk to 0.8x at hour-1 ≥ 100k
  (ramping in log space from 20k) and widened to 1.15x at hour-1 ≤ 5k:
  the band was over-wide where it matters most (coverage 0.97 at
  hour-1 ≥ 50k) and slightly under-covered at tiny hour-1 (0.81).
- **Top-end median shrink.** At hour-1 ≥ 300k the predicted log-ratio is
  shrunk toward flat (0% at 300k, 30% at 1M in this round): the biggest
  launches' evenings are flatter than the size law alone predicts, and a
  stronger shrink makes the extrapolated top end less sensitive to how
  the quadratic bends at the low end.

Either component falls back to the house baseline shape for an hour it lacks
data for. The comparable pool drops any launch without a real hour-1 print
or with fewer than 20 of hours 2–24 (this drops the GTA VI category itself,
which has no release day yet). Pure function of the input case: deterministic,
byte-identical outputs across runs.

## What changed in round 3 (vs round 2)

Exactly two constants, both validated on three leave-one-launch-out pools
(kit 37 launches; 37 + 2 extra launches fetched from SullyGnome, Palworld
and Oblivion Remastered; and the 41 launches the final case ships, i.e.
37 + the 4 practice launches):

- Blend weight on the regression component: **0.6 → 0.8**. The neighbour
  component is an equal-weight mean of 8 launches — high-variance wherever
  neighbours are sparse — while the quadratic pools every comparable into
  one smooth curve. The weight sweep peaks at 0.8 on the 37- and 41-pools
  and falls off on both sides (0.9 and 1.0 are worse), so 0.8 is an interior
  optimum, continuing the direction round 2 already took (0.5 → 0.6).
- Top-end median shrink: **0.2 → 0.3**. The 37-pool sweep is flat for this
  parameter on its own, but combined with the 0.8 blend it is the only
  variant whose big-launch slice never loses on any of the three pools.

Everything else was tried and rejected on the same evidence: a per-hour
median-bias correction (its evening bias lives only in tiny hour-1
launches; at hour-1 ≥ 100k it is ~0, so a global correction would push
the live forecast ~12% too high), a pre-release hype feature (hurts the
big-launch regime, LOLO ≥100k 0.191 → 0.210), hour-1 channel count
(partial corr −0.066), robust Huber quadratic, distance-weighted
neighbours, flat-day shrink, spread rescaling, and a linear fit —
all flat or worse on at least one pool. One caution: adding the two
extra launches alone reverses the *overall* LOLO gain for the blend
weight (driven by Oblivion Remastered, an extreme low-end outlier,
h1 = 56 with a 7488x evening ratio, levering the quadratic). It does
not reverse the big-launch slice, and those two launches are not
comparables in the final case — the deployment pool is the 41.

## Validation (leave-one-launch-out over 37 past launches + 4 practice cases)

Pinball loss on the log scale, lower is better. House baseline: 0.387 on the
practice (0.930 on the 37-launch LOLO pool, where tiny-hour-1 launches
punish a flat forecast hard). Round 3 beats round 2 on every check that
matters for the live launch:

| check | round 3 | round 2 | house baseline |
|---|---|---|---|
| Practice mean (p00–p03) | **0.161** | 0.165 | 0.387 |
| Practice p00 Wolverine | 0.174 | 0.199 | 0.744 |
| Practice p01 RDR2 | 0.162 | 0.154 | 0.287 |
| Practice p02 GoW Ragnarök | 0.122 | 0.119 | 0.215 |
| Practice p03 Spider-Man 2 | 0.184 | 0.187 | 0.303 |
| LOLO mean (37 launches) | **0.360** | 0.365 | 0.930 |
| LOLO wins vs baseline | **32 / 37** | 32 / 37 | — |
| LOLO 90% coverage | 0.885 (nominal 0.90) | 0.899 | 0.792 |
| Big-hour-1 launches only (h1 ≥ 50k, the plausible GTA VI regime) | **0.188** | 0.191 | 0.251 |
| Big-hour-1 wins vs baseline | 17 / 20 | 17 / 20 | — |
| LOLO mean (41-launch pool) | **0.341** | 0.345 | — |
| LOLO ≥100k (41-launch pool) | **0.182** | 0.184 | — |

The overall LOLO gain is small (~1%) and partly driven by two small
launches (Silksong −0.146, RE Requiem −0.078); the live-regime gain is
the real one and it is small too (−0.002 to −0.003 on the ≥100k slice,
broad-based: 10 launches improve vs 6 worsen there on the 41-pool).
The TypeScript entry reproduces the Python backtest numbers exactly on
every metric above.

Practice answers were reconstructed from the same public SullyGnome source
the kit documents, anchored by the exact 3-point match on each case's
history; the scorer reproduces the house baseline's stated practice loss
(0.387) exactly, which validates both the answers and the scorer. No
practice answer is memorized or hardcoded: the program reads one case
and forecasts it.

## Honest risks

- **The final is one launch, not 37.** GTA VI is bigger than any comparable;
  if its hour-1 print lands far above the largest comparable (~875k), the
  regression follows its local slope with the extra move capped at 0.5 in
  log space, and the median is shrunk toward flat — but no comparable has
  ever been that big, so the top end is still an extrapolation.
- **A flat day beats us.** On big-hour-1 launches whose day is genuinely
  flat, the house baseline (flat forecast) is nearly optimal and we lose by
  a little (worst LOLO case: Diablo IV, +0.12). Our edge is concentrated in
  launches that grow after hour 1 — which is exactly what a rolling-midnight
  launch like GTA VI should do.
- **The unlock shift can misfire.** It is fitted from 12 rolling vs 25
  simultaneous launches and applied at 80% strength. If GTA VI's unlock
  behaves unlike the rolling group (e.g. a much later US peak), the shift
  pushes the evening median the wrong way; the shift is bounded by the
  observed residual gap, so the damage is limited to ~0.2–0.3 log units.
- **The round-3 gain is small and pool-sensitive.** It survives on the
  live-regime slice of all three validation pools, but if the final's
  comparable set behaved like the two-launch extension (an extreme
  low-end outlier levering the quadratic), the blend-weight change
  could cost a little instead of gaining. The change is kept because
  the deployment pool — the 41 launches the final case actually ships —
  supports it, and the top-end shrink specifically guards the
  extrapolated regime.

## Run locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=<kit>/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads every `*.in` in the input dir (name order) and writes one `<id>.out`
per case. Runtime: ~0.03 s per case (cap 8 s).
