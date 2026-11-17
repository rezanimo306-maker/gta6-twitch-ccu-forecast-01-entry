[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![make.fun · gta6-twitch-ccu-forecast-01 rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/rezanimo306-maker/gta6-twitch-ccu-forecast-01-entry/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![make.fun · gta6-twitch-ccu-forecast-01 reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/rezanimo306-maker/gta6-twitch-ccu-forecast-01-entry/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

# GTA VI launch-day Twitch viewers — hour-by-hour forecast (round 2)

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
ln(hour-1 print), as the geometric mean of two components (weights 0.6 / 0.4):

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
  shrunk toward flat (0% at 300k, 20% at 1M): the biggest launches'
  evenings are flatter than the size law alone predicts.

Either component falls back to the house baseline shape for an hour it lacks
data for. The comparable pool drops any launch without a real hour-1 print
or with fewer than 20 of hours 2–24 (this drops the GTA VI category itself,
which has no release day yet). Pure function of the input case: deterministic,
byte-identical outputs across runs.

## Validation (leave-one-launch-out over 37 past launches + 4 practice cases)

Pinball loss on the log scale, lower is better. House baseline: 0.387 on the
practice (0.930 on the 37-launch LOLO pool, where tiny-hour-1 launches
punish a flat forecast hard). Round 2 beats round 1 on every check:

| check | round 2 | round 1 | house baseline |
|---|---|---|---|
| Practice mean (p00–p03) | **0.165** | 0.217 | 0.387 |
| Practice p00 Wolverine | 0.199 | 0.284 | 0.744 |
| Practice p01 RDR2 | 0.154 | 0.229 | 0.287 |
| Practice p02 GoW Ragnarök | 0.119 | 0.163 | 0.215 |
| Practice p03 Spider-Man 2 | 0.187 | 0.193 | 0.303 |
| LOLO mean (37 launches) | **0.365** | 0.387 | 0.930 |
| LOLO wins vs baseline | **32 / 37** | 28 / 37 | — |
| LOLO 90% coverage | 0.899 (nominal 0.90) | 0.902 | 0.792 |
| Big-hour-1 launches only (h1 ≥ 50k, the plausible GTA VI regime) | **0.191** | 0.212 | 0.251 |
| Big-hour-1 wins vs baseline | 17 / 20 | 13 / 20 | — |

No launch flips from a win to a loss against the house baseline between
round 1 and round 2; four launches flip the other way (Monster Hunter
Wilds, Black Ops 6, Starfield, Marvel Rivals). The largest single
regression is +0.061 (FF7 Rebirth). The TypeScript entry reproduces the
Python backtest numbers exactly on every metric above.

Practice answers were reconstructed from the same public SullyGnome source
the kit documents, anchored by the exact 3-point match on each case's
history; the scorer reproduces the house baseline's stated practice loss
(0.387) exactly, which validates both the answers and the scorer.

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

## Run locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=<kit>/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads every `*.in` in the input dir (name order) and writes one `<id>.out`
per case. Runtime: ~0.03 s per case (cap 8 s).
