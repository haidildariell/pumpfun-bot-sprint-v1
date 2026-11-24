[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/haidildariell/pumpfun-bot-sprint-v1/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/haidildariell/pumpfun-bot-sprint-v1/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Pump.fun Bot Sprint — momentum paper-trading bot

Entry for https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed

A deterministic momentum bot that paper-trades pump.fun bonding curves on a
replay of chain data (agent-fun/replay/v2). It reads TradeEvent / CreateEvent /
CompleteEvent as they arrive and decides when to buy, when to sell, and how
much to risk — beating hold-cash is the bar.

## Strategy

Most new coins die fast; a minority runs hard. The bot only buys once a
coin's own tape proves buyers are in control:

- price up >= 8% vs 12 trades ago, and >= 10% above the 12-trade low;
- net buy flow over the same window (buy SOL volume > sell SOL volume);
- still early: price below 2.5x its first trade price;
- liquid enough: real SOL reserve >= 2 SOL, so the 1%-of-reserve order cap
  still allows a >= 0.02 SOL entry.

Size is 0.1 SOL per entry (capped at 1% of real reserve), max 5 open
positions. Exits are mechanical: take profit +35%, trailing stop 10% below
the peak since entry, hard stop -15%, max hold 150 trades or 3000 slots.
After an exit the coin cools down for 1200 slots before it can be re-entered.

Fees are respected in sizing: every order pays 105,000 lamports in tx fees
plus ~125 bps of curve fees, so entries are sized so a single fill can cover
its own costs.

## Determinism

Every decision is a pure function of the replay events. No clock, no
`Math.random`, no environment, no network, no files. Prices are compared with
exact bigint cross-multiplication on virtual reserves, so two runs produce
byte-identical action logs.

## Layout

- `main.ts` — wire protocol (stdin JSONL hello/batch/done, one reply per
  batch on stdout) and bot state: cash, positions, curves, pending orders.
- `strategy.ts` — the momentum strategy: per-mint trade windows, entry
  filters, exits, cooldowns.

## Run locally

```sh
node main.ts   # speaks agent-fun/replay/v2 on stdin/stdout
```
