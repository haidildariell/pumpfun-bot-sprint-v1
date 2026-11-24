// Momentum trend-following strategy for pump.fun bonding curves.
//
// Idea: most new coins die fast; a minority runs hard. We only buy a coin
// once its own tape proves buyers are in control — price up sharply from its
// recent low with net buy flow — and only while it is still early (price not
// yet far above where it started) and liquid enough that our order fits the
// 1%-of-real-reserve cap at a size that covers the 105,000-lamport tx fee.
// Exits are mechanical: take profit, trailing stop, hard stop, max hold.
// Everything is a pure function of the replay events: no clock, no random.
//
// All price comparisons use exact bigint cross-multiplication on the
// virtual-reserve ratio (virtualQuote / virtualToken), so results are
// identical on every run.

import {
  type BotState,
  txFeeLamports,
  maxBuyLamports,
  committedPositions,
  freeCashLamports,
} from "./main.ts";

// Local copy: importing the const from main.ts would hit the ESM circular
// import (main.ts imports this file) while it is still in TDZ.
const LAMPORTS_PER_SOL = 1_000_000_000n;

export interface RawOrder {
  side: "buy" | "sell";
  mint: string;
  amount: bigint;
  maxSlippageBps: number;
}

// ---- tunables (lamports unless noted) ----
const WINDOW_TRADES = 12; // lookback window, in trades on the mint
const MIN_TRADES = 6; // trades seen before a mint is eligible
const MOM_BPS = 800; // price now vs WINDOW_TRADES ago must be >= +8%
const BOUNCE_BPS = 1000; // price now vs window low must be >= +10%
const MAX_FIRST_MULT_BPS = 25_000; // price now <= 2.5x first trade price
const MIN_REAL_SOL = 2n * LAMPORTS_PER_SOL; // real SOL reserve needed
const BUY_TARGET = 100_000_000n; // 0.1 SOL per entry
const MIN_BUY = 20_000_000n; // 0.02 SOL smallest entry
const BUY_SLIPPAGE_BPS = 800;
const SELL_SLIPPAGE_BPS = 1000;
const TAKE_PROFIT_BPS = 3500; // +35% vs entry cost per token
const TRAIL_BPS = 1000; // sell at 10% below peak since entry
const STOP_BPS = 1500; // sell at 15% below entry cost per token
const MAX_HOLD_TRADES = 150; // max trades on the mint while holding
const MAX_HOLD_SLOTS = 3000; // max slots while holding
const COOLDOWN_SLOTS = 1200; // no re-entry right after an exit

interface Price {
  q: bigint;
  t: bigint;
}

interface TradePoint {
  price: Price;
  isBuy: boolean;
  solAmount: bigint;
}

export interface MintTrack {
  firstPrice: Price | null;
  points: TradePoint[]; // last WINDOW_TRADES trades, oldest first
  trades: number;
}

export interface OpenTrade {
  entryCost: Price; // { costLamports, tokenAmount } => cost per token
  peak: Price;
  entrySlot: number;
  entryTrades: number;
}

export interface StrategyState {
  mintTrack: Map<string, MintTrack>;
  openTrades: Map<string, OpenTrade>;
  cooldownUntil: Map<string, number>;
  stats: { buys: number; sells: number; entries: number };
}

// price a >= price b * (10000 + bps) / 10000
function priceGteByBps(a: Price, b: Price, bps: number): boolean {
  const num = 10_000n + BigInt(bps);
  return a.q * b.t * 10_000n >= b.q * a.t * num;
}

// price a <= price b * (10000 - bps) / 10000
function priceLteByBps(a: Price, b: Price, bps: number): boolean {
  const num = 10_000n - BigInt(bps);
  return a.q * b.t * 10_000n <= b.q * a.t * num;
}

// price a < price b
function priceLt(a: Price, b: Price): boolean {
  return a.q * b.t < b.q * a.t;
}

function curvePrice(state: BotState, mint: string): Price | null {
  const c = state.curves.get(mint);
  if (c === undefined || c.virtualToken === 0n || c.complete) return null;
  return { q: c.virtualQuote, t: c.virtualToken };
}

function pendingSide(state: BotState, mint: string, side: "buy" | "sell"): boolean {
  for (const p of state.pending.values()) {
    if (p.mint === mint && p.side === side) return true;
  }
  return false;
}

export function decideOrders(state: BotState, batch: any): RawOrder[] {
  const orders: RawOrder[] = [];

  // ---- 1. fold this batch's trades into per-mint tracks ----
  for (const e of batch.events) {
    if (e.event !== "TradeEvent") continue;
    let track = state.mintTrack.get(e.mint);
    if (track === undefined) {
      track = { firstPrice: null, points: [], trades: 0 };
      state.mintTrack.set(e.mint, track);
    }
    const price: Price = {
      q: BigInt(e.virtual_quote_reserves),
      t: BigInt(e.virtual_token_reserves),
    };
    if (track.firstPrice === null) track.firstPrice = price;
    track.points.push({ price, isBuy: e.is_buy, solAmount: BigInt(e.sol_amount) });
    if (track.points.length > WINDOW_TRADES) track.points.shift();
    track.trades += 1;
  }

  // ---- 2. sync open trades with the account (fills create them) ----
  for (const [mint, pos] of state.positions) {
    let ot = state.openTrades.get(mint);
    const price = curvePrice(state, mint);
    if (ot === undefined) {
      ot = {
        entryCost: { q: pos.costLamports, t: pos.tokenAmount },
        peak: price ?? { q: pos.costLamports, t: pos.tokenAmount },
        entrySlot: state.slot,
        entryTrades: state.mintTrack.get(mint)?.trades ?? 0,
      };
      state.openTrades.set(mint, ot);
    } else if (price !== null && priceLt(ot.peak, price)) {
      ot.peak = price;
    }
  }
  // positions that are gone: close the trade record, start cooldown
  for (const mint of [...state.openTrades.keys()]) {
    if (!state.positions.has(mint) && !pendingSide(state, mint, "sell")) {
      state.openTrades.delete(mint);
      state.cooldownUntil.set(mint, state.slot + COOLDOWN_SLOTS);
    }
  }

  // ---- 3. exits first (free slots and realise gains/limit losses) ----
  for (const [mint, pos] of state.positions) {
    if (pendingSide(state, mint, "sell")) continue;
    const ot = state.openTrades.get(mint);
    const price = curvePrice(state, mint);
    if (ot === undefined || price === null) continue;
    const track = state.mintTrack.get(mint);
    const heldTrades = (track?.trades ?? 0) - ot.entryTrades;
    const heldSlots = state.slot - ot.entrySlot;
    const takeProfit = priceGteByBps(price, ot.entryCost, TAKE_PROFIT_BPS);
    const trailing = priceLteByBps(price, ot.peak, TRAIL_BPS);
    const stopped = priceLteByBps(price, ot.entryCost, STOP_BPS);
    const tooLong = heldTrades >= MAX_HOLD_TRADES || heldSlots >= MAX_HOLD_SLOTS;
    if (takeProfit || trailing || stopped || tooLong) {
      orders.push({
        side: "sell",
        mint,
        amount: pos.tokenAmount,
        maxSlippageBps: SELL_SLIPPAGE_BPS,
      });
      state.stats.sells += 1;
    }
  }

  // ---- 4. entries: momentum confirmed, early, liquid, room to hold ----
  const maxOpen = state.hello.caps.max_open_positions as number;
  if (committedPositions(state) < maxOpen) {
    const txFee = txFeeLamports(state);
    for (const [mint, track] of state.mintTrack) {
      if (committedPositions(state) >= maxOpen) break;
      if (orders.length >= (state.hello.caps.max_orders_per_batch as number)) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (state.positions.has(mint)) continue;
      if (pendingSide(state, mint, "buy")) continue;
      if ((state.cooldownUntil.get(mint) ?? -1) > state.slot) continue;
      if (track.trades < MIN_TRADES) continue;
      if (track.points.length < WINDOW_TRADES) continue;
      if (curve.realQuote < MIN_REAL_SOL) continue;
      const price = curvePrice(state, mint);
      if (price === null || track.firstPrice === null) continue;
      // still early: not yet 2.5x its first trade price
      if (priceGteByBps(price, track.firstPrice, MAX_FIRST_MULT_BPS - 10_000)) continue;
      // momentum: up >= 8% vs WINDOW_TRADES ago
      const old = track.points[0].price;
      if (!priceGteByBps(price, old, MOM_BPS)) continue;
      // bounce: up >= 10% vs the window low
      let low = track.points[0].price;
      let buyQuote = 0n;
      let sellQuote = 0n;
      for (const p of track.points) {
        if (priceLt(p.price, low)) low = p.price;
        if (p.isBuy) buyQuote += p.solAmount;
        else sellQuote += p.solAmount;
      }
      if (!priceGteByBps(price, low, BOUNCE_BPS)) continue;
      // net buy flow over the window
      if (buyQuote <= sellQuote) continue;
      // size: target 0.1 SOL, capped at 1% of real reserve, at least 0.02 SOL
      const cap = maxBuyLamports(state, mint);
      let size = BUY_TARGET < cap ? BUY_TARGET : cap;
      if (size < MIN_BUY) continue;
      if (freeCashLamports(state) < size + txFee) continue;
      orders.push({ side: "buy", mint, amount: size, maxSlippageBps: BUY_SLIPPAGE_BPS });
      state.stats.buys += 1;
      state.stats.entries += 1;
      // reserve the cash/slot immediately so later mints in this batch see it
      state.pending.set(`__plan_${mint}`, { side: "buy", mint, amount: size });
    }
    // drop the planning reservations (real client ids are assigned by main.ts)
    for (const k of [...state.pending.keys()]) {
      if (k.startsWith("__plan_")) state.pending.delete(k);
    }
  }

  return orders;
}
