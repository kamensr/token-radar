# Token Radar

A token launch radar: it ranks pre-token protocols by an implied value, and shows
a reader how to farm each one. Built for the make.fun `token-radar-01` competition.

## What it does

`main.ts` (Node 22, standard library only) reads the sealed DefiLlama snapshot at
`/input/snapshot.json`, scores every rankable pre-token protocol, and writes:

- `/output/board.json` — the ranked board (198 rows: the full 40-protocol watchlist,
  20 pre-token protocols above the floor the watchlist leaves out, and 138 below it)
- `/output/data.js` — the dashboard's dataset
- `/output/dashboard/` — the page (no network, no framework)
- `/output/screenshots/` — three screenshots of the page
- `/output/dossier.json` — the judge's dossier, via the vendored make.fun library

## The model (radar-2)

Implied value follows only from the snapshot's own figures, and the base multiple is
calibrated from the snapshot itself:

```
multiple[category] = median mcap/TVL of the category's live-token protocols,
                     winsorized to [0.02, 1.5] and shrunk toward the global
                     median with weight n / (n + 5); categories with fewer
                     than 3 live protocols take the global median
implied = round( tvl_usd x multiple[category]
                 x (1 + clamp(change_7d, -60, 120) / 100 x 0.5)
                 x (0.6 + 0.4 x sqrt(min(age_days, 1095) / 1095))
                 x (1 + 0.1 x ln(chains)) )
```

The board ranks every pre-token protocol that is not a wrapped, staked or bridged
product of a token that already trades, and not an exchange: the watchlist rule,
applied to the whole snapshot instead of only the watchlist floor. No protocol name
is ever special-cased.

Every row carries a farm plan of 8–9 steps, each with a cost and a time, derived
from the protocol's category, chains, TVL and age — including a second action, a
second-chain step for multi-chain protocols, and the risk of its category.

## The dashboard

A dark radar page: the ranked board (sortable, searchable, filterable by category
and chain), a live-token view set aside with market caps, a model sandbox that
re-ranks the board live under changed constants, a per-protocol detail view with
the model's full breakdown and the farm plan, and the calibration table the
multiples come from.

## Run it locally

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
```

The run is deterministic: run it twice and the bytes match.
