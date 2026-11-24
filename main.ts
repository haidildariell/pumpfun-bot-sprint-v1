// Pump.fun replay bot — agent-fun/replay/v2.
//
// Reads newline-delimited JSON from stdin (hello, batch, done), answers every
// batch with exactly one JSON reply line on stdout. Diagnostics go to stderr.
// Fully deterministic: every decision is a pure function of the events seen so
// far. No clock, no randomness, no environment, no network, no files.
//
// Wire protocol (from protocol.schema.json in the competition kit):
//   hello: { type, protocol: "agent-fun/replay/v2", seed, universe, capital,
//            caps, latency_slots, fees }
//   batch: { type, seq, slot, events[], marks[], fills[], account }
//   done:  { type, seq, reason, account }
//   reply: { type: "reply", seq, orders: [...] }
// Buy order:  { side: "buy", client_id, mint, quote_lamports, max_slippage_bps }
// Sell order: { side: "sell", client_id, mint, token_amount, max_slippage_bps }
// Amounts are u64 decimal strings. client_id is 1-64 chars [A-Za-z0-9_-],
// never starting with "_" (reserved for the harness's own closes).

import { decideOrders, type StrategyState } from "./strategy.ts";

export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const BPS = 10_000n;

export interface Curve {
  mint: string;
  createdSlot: number | null;
  virtualToken: bigint;
  virtualQuote: bigint;
  realToken: bigint;
  realQuote: bigint;
  reservesSlot: number;
  trades: number;
  complete: boolean;
}

export interface Holding {
  tokenAmount: bigint;
  costLamports: bigint;
}

export interface PendingOrder {
  side: "buy" | "sell";
  mint: string;
  amount: bigint;
}

export interface BotState extends StrategyState {
  hello: any;
  seq: number;
  slot: number;
  cash: bigint;
  positions: Map<string, Holding>;
  curves: Map<string, Curve>;
  pending: Map<string, PendingOrder>;
}

interface Order {
  side: "buy" | "sell";
  client_id: string;
  mint: string;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
}

const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/;

let nextClient = 1;
const usedIds = new Set<string>();

function freshClientId(): string {
  for (;;) {
    const id = `o${nextClient++}`;
    if (!usedIds.has(id)) {
      usedIds.add(id);
      return id;
    }
  }
}

function txFeeLamports(state: BotState): bigint {
  return BigInt(state.hello.fees.base_fee_lamports) + BigInt(state.hello.fees.priority_fee_lamports);
}

function maxBuyLamports(state: BotState, mint: string): bigint {
  const c = state.curves.get(mint);
  if (c === undefined || c.complete) return 0n;
  return (c.realQuote * BigInt(state.hello.caps.max_order_bps_of_real_reserve)) / BPS;
}

function committedPositions(state: BotState): number {
  const mints = new Set<string>(state.positions.keys());
  for (const p of state.pending.values()) if (p.side === "buy") mints.add(p.mint);
  return mints.size;
}

function freeCashLamports(state: BotState): bigint {
  const tx = txFeeLamports(state);
  let free = state.cash;
  for (const p of state.pending.values()) {
    free -= tx;
    if (p.side === "buy") free -= p.amount;
  }
  return free;
}

function newCurve(mint: string, created: number | null, slot: number): Curve {
  return {
    mint,
    createdSlot: created,
    virtualToken: 0n,
    virtualQuote: 0n,
    realToken: 0n,
    realQuote: 0n,
    reservesSlot: slot,
    trades: 0,
    complete: false,
  };
}

function setAccount(state: BotState, account: any): void {
  state.cash = BigInt(account.cash_lamports);
  state.positions.clear();
  for (const p of account.positions) {
    const tokens = BigInt(p.token_amount);
    if (tokens > 0n) {
      state.positions.set(p.mint, {
        tokenAmount: tokens,
        costLamports: BigInt(p.cost_lamports),
      });
    }
  }
}

function applyBatch(state: BotState, batch: any): void {
  state.seq = batch.seq;
  state.slot = batch.slot;
  for (const f of batch.fills) state.pending.delete(f.client_id);
  setAccount(state, batch.account);
  for (const m of batch.marks) {
    const c = state.curves.get(m.mint);
    if (c !== undefined && m.slot < c.reservesSlot) continue;
    const curve = c ?? newCurve(m.mint, null, m.slot);
    if (c === undefined) state.curves.set(m.mint, curve);
    curve.virtualToken = BigInt(m.virtual_token_reserves);
    curve.virtualQuote = BigInt(m.virtual_quote_reserves);
    curve.realToken = BigInt(m.real_token_reserves);
    curve.realQuote = BigInt(m.real_quote_reserves);
    curve.reservesSlot = m.slot;
  }
  for (const e of batch.events) {
    if (e.event === "CreateEvent") {
      const curve = newCurve(e.mint, e.slot, e.slot);
      curve.virtualToken = BigInt(e.virtual_token_reserves);
      curve.virtualQuote = BigInt(e.virtual_quote_reserves);
      curve.realToken = BigInt(e.real_token_reserves);
      curve.realQuote = 0n;
      state.curves.set(e.mint, curve);
    } else if (e.event === "TradeEvent") {
      let curve = state.curves.get(e.mint);
      if (curve === undefined) {
        curve = newCurve(e.mint, null, e.slot);
        state.curves.set(e.mint, curve);
      }
      curve.virtualToken = BigInt(e.virtual_token_reserves);
      curve.virtualQuote = BigInt(e.virtual_quote_reserves);
      curve.realToken = BigInt(e.real_token_reserves);
      curve.realQuote = BigInt(e.real_quote_reserves);
      curve.reservesSlot = e.slot;
      curve.trades += 1;
    } else if (e.event === "CompleteEvent") {
      let curve = state.curves.get(e.mint);
      if (curve === undefined) {
        curve = newCurve(e.mint, null, e.slot);
        state.curves.set(e.mint, curve);
      }
      curve.complete = true;
    }
  }
}

function validateOrder(o: any, where: string): void {
  if (typeof o !== "object" || o === null || Array.isArray(o)) {
    throw new Error(`${where}: expected an order object`);
  }
  if (o.side !== "buy" && o.side !== "sell") throw new Error(`${where}: bad side`);
  if (typeof o.mint !== "string" || !PUBKEY_RE.test(o.mint)) {
    throw new Error(`${where}: bad mint`);
  }
  const key = o.side === "buy" ? "quote_lamports" : "token_amount";
  const v = o[key];
  if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(v)) {
    throw new Error(`${where}: bad ${key}`);
  }
  if (
    typeof o.max_slippage_bps !== "number" ||
    !Number.isInteger(o.max_slippage_bps) ||
    o.max_slippage_bps < 0 ||
    o.max_slippage_bps > 10_000
  ) {
    throw new Error(`${where}: bad max_slippage_bps`);
  }
  if (typeof o.client_id !== "string" || !CLIENT_ID_RE.test(o.client_id)) {
    throw new Error(`${where}: bad client_id`);
  }
}

async function main(): Promise<void> {
  let state: BotState | null = null;
  let buf = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for await (const chunk of process.stdin) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (line.trim() === "") continue;
      const msg = JSON.parse(line);
      if (msg.type === "hello") {
        if (state !== null) throw new Error("second hello");
        if (msg.protocol !== "agent-fun/replay/v2") {
          throw new Error(`unsupported protocol ${msg.protocol}`);
        }
        state = {
          hello: msg,
          seq: -1,
          slot: -1,
          cash: BigInt(msg.capital.lamports),
          positions: new Map(),
          curves: new Map(),
          pending: new Map(),
          mintTrack: new Map(),
          openTrades: new Map(),
          cooldownUntil: new Map(),
          stats: { buys: 0, sells: 0, entries: 0 },
        };
      } else if (msg.type === "batch") {
        if (state === null) throw new Error("batch before hello");
        applyBatch(state, msg);
        const raw = decideOrders(state, msg);
        const orders: Order[] = [];
        for (let i = 0; i < raw.length; i++) {
          const r = raw[i];
          const id = freshClientId();
          const o: Order =
            r.side === "buy"
              ? {
                  side: "buy",
                  client_id: id,
                  mint: r.mint,
                  quote_lamports: r.amount.toString(),
                  max_slippage_bps: r.maxSlippageBps,
                }
              : {
                  side: "sell",
                  client_id: id,
                  mint: r.mint,
                  token_amount: r.amount.toString(),
                  max_slippage_bps: r.maxSlippageBps,
                };
          validateOrder(o, `batch ${msg.seq} order ${i}`);
          orders.push(o);
          state.pending.set(id, { side: r.side, mint: r.mint, amount: r.amount });
        }
        process.stdout.write(JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n");
      } else if (msg.type === "done") {
        if (state === null) throw new Error("done before hello");
        setAccount(state, msg.account);
        console.error(
          `done reason=${msg.reason} cash=${state.cash} buys=${state.stats.buys} sells=${state.stats.sells} entries=${state.stats.entries}`,
        );
        return;
      } else {
        throw new Error(`unknown message type ${msg.type}`);
      }
    }
  }
  throw new Error(state === null ? "input ended before hello" : "input ended before done");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});

// Helpers the strategy uses (exported for strategy.ts).
export { txFeeLamports, maxBuyLamports, committedPositions, freeCashLamports };
