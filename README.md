# Token Radar 3

A token-launch radar that ranks pre-token protocols by a market-cap peer analogue
and shows a cautious activity plan. Built for make.fun's token-radar-01.

## What it does

main.ts reads the sealed DefiLlama snapshot and writes the ranked board,
dashboard data, page, screenshots, and judge dossier. The board covers all
40 watchlist protocols and adds pre-token protocols above and below that floor.

## The model (radar-3)

The estimate fits a robust Theil-Sen curve to listed-token peers from the same
snapshot. Peers need positive TVL and market cap plus a listing date.

    log(mcap/TVL) = intercept + beta * log(TVL / $100M)
    implied_cap = TVL * exp(intercept + beta * log(TVL / $100M))

The dashboard reports leave-one-out and earlier-listing held-out diagnostics,
plus a peer-error band. These measure valuation error within this single frozen
snapshot. They are not launch odds, timing, or a confidence interval for a
future token.

The board also shows an eight-to-nine-step activity plan with costs, timing,
category risks, and a second action. Plans are heuristics; verify incentives,
contracts, fees, and risks before acting.

## Dashboard

Sortable rows, search and filters, a live-token view, the model audit,
scenario controls, and protocol details. Filtering preserves global ranks,
and the detail view recomputes the same estimate shown in the board.

## Run locally

    MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json-or-directory>

Two runs produce byte-identical outputs.
