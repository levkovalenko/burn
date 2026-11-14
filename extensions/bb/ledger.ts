import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { listCost, priceOf } from "../../src/prices.js";
import { type CostParts, type EntryLike, promptExcerpt, type TokenParts } from "../../src/report.js";
import type { Harness } from "./harnesses.js";

export type EventRow = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>[number];
type RowOf<T extends EventRow["type"]> = Extract<EventRow, { type: T }>;

/** The thread events a ledger reads: who asked for each turn, the items that start each call, and what each session used and cost. */
export const USAGE_EVENTS = [
  "client/turn/requested",
  "turn/started",
  "item/started",
  "thread/tokenUsage/updated",
  "thread/contextWindowUsage/updated",
  "provider/error",
] as const;

/** A session's token counts as its provider bridge gives them to bb. */
export type Totals = RowOf<"thread/tokenUsage/updated">["data"]["tokenUsage"]["total"];

export type SplitTokens = TokenParts & { reasoning: number };

/** What one usage event added to a thread; `model` is the bare id the latest request named, and `ms` the call it ended. */
export type LedgerRecord =
  | { kind: "prompt"; at: number; text: string }
  | { kind: "tokens"; at: number; session: string; model: string; tokens: SplitTokens; single: boolean; ms?: number }
  | { kind: "cost"; at: number; session: string; model: string; usd: number }
  /** A model call the provider refused; `ms` when it was already in flight, so a refusal before it is untimed. */
  | { kind: "error"; at: number; session: string; model: string; ms?: number };

export interface SessionState {
  total: Totals | null;
  /** Older counters under the same provider id, newest first: a native child's counter can share its parent's id. */
  earlier?: Totals[];
  /** The session's latest cumulative cost in dollars. */
  usd: number | null;
  /** The harness recorded a cost for the session, so its tokens are never priced. */
  costed: boolean;
  /** The start of the call in flight: the first item of its response, awaiting the usage event that ends it. */
  callOpen?: { at: number } | null;
}

export interface LedgerState {
  /** The seq of the last usage event read. */
  afterSeq: number | null;
  /** When the newest change a report reads arrived. */
  at: number | null;
  model: string | null;
  sessions: Record<string, SessionState>;
  /** Native child turns share the parent provider id in BB; their counters do not. */
  childTurns?: Record<string, string>;
}

export interface Ledger {
  state: LedgerState;
  records: LedgerRecord[];
}

export const newLedger = (): Ledger => ({ state: { afterSeq: null, at: null, model: null, sessions: {} }, records: [] });

const UNKNOWN_MODEL = "unknown";
const FIELDS = [
  "totalTokens",
  "inputTokens",
  "cachedInputTokens",
  "cacheReadInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
] as const;

const same = (a: Totals, b: Totals): boolean => FIELDS.every((f) => a[f] === b[f]);
const isZero = (t: Totals): boolean => FIELDS.every((f) => (t[f] ?? 0) === 0);

function minus(a: Totals, b: Totals): Totals {
  const out: Totals = { ...a };
  for (const f of FIELDS) {
    const value = a[f];
    if (value !== undefined) out[f] = Math.max(0, value - (b[f] ?? 0));
  }
  return out;
}

const sessionOf = (state: LedgerState, id: string): SessionState =>
  (Object.hasOwn(state.sessions, id) ? state.sessions[id] : undefined) ?? { total: null, usd: null, costed: false };

/** A span that is not one call's: negative is a broken clock, longer a window of calls whose usage bb deleted. */
const MAX_CALL_MS = 5 * 60 * 1000;
/** The items that begin a model call's response; the tool items it spawns are not calls. */
const CALL_ITEM_KINDS = ["reasoning", "agentMessage", "toolCall"] as const;

/** The session an event's scope belongs to: a native child's counters are kept apart from the parent's. */
const sessionId = (state: LedgerState, data: { providerThreadId: string }, scope: EventRow["scope"]): string => {
  const child = scope.kind === "turn" ? state.childTurns?.[scope.turnId] : undefined;
  return child ? `${data.providerThreadId}:child:${child}` : data.providerThreadId;
};

/** Counters one provider id keeps at once; see withCounter for which drops past this. */
const COUNTERS = 8;

/** A session's counters, newest first: its total, then the earlier ones. */
const countersOf = (session: SessionState): Totals[] => (session.total === null ? [] : [session.total, ...(session.earlier ?? [])]);

/**
 * The counters with a new one in front. Past the cap the smallest older counter
 * drops, not the one idle longest: a dropped counter's next call counts its whole
 * total again, and a parent waiting on its children is both the idlest and the largest.
 */
function withCounter(total: Totals, counters: readonly Totals[]): Totals[] {
  if (counters.length < COUNTERS) return [total, ...counters];
  const smallest = counters.reduce((min, c, i) => (c.totalTokens < (counters[min] as Totals).totalTokens ? i : min), 0);
  return [total, ...counters.filter((_, i) => i !== smallest)];
}

/**
 * What a provider id's new total adds, and the counters it leaves. A total that
 * continues a counter adds what that counter gained: its total plus this call's
 * tokens is the new total. This holds per counter, so a native child's calls under
 * the parent's id do not count the parent's total again. Otherwise a lower total, or
 * one equal to its own last call, is a restart and counts in full: bridges that sum
 * `last` in worker memory start again from zero when the worker restarts. Any other
 * total counts the newest counter's growth, which covers missed calls and repeats.
 */
function addedBy(counters: readonly Totals[], total: Totals, last: Totals): { added: Totals; counters: Totals[] } {
  const index = counters.findIndex((c) => c.totalTokens + last.totalTokens === total.totalTokens);
  if (index >= 0) return { added: minus(total, counters[index] as Totals), counters: [total, ...counters.filter((_, i) => i !== index)] };
  // Only the newest counter's exact total is a repeat: an older counter can share a total with a real call.
  const newest = counters[0];
  if (newest === undefined || (newest.totalTokens > 0 && same(total, last) && !same(total, newest)) || total.totalTokens < newest.totalTokens) {
    return { added: total, counters: withCounter(total, counters) };
  }
  // No counter continues, so calls were missed on the newest one: count its growth. A repeat of it adds nothing.
  return { added: minus(total, newest), counters: [total, ...counters.slice(1)] };
}

/** bb's token counts as Burn's kinds. Reasoning is shown, never priced: it is part of output. */
export function splitTokens(t: Totals, inCache: boolean | null): SplitTokens {
  const cacheWrite = t.cacheWriteInputTokens ?? 0;
  const cacheRead = t.cacheReadInputTokens ?? Math.max(0, t.cachedInputTokens - cacheWrite);
  const inside =
    inCache ?? (t.totalTokens > 0 && cacheRead + cacheWrite > 0 && t.totalTokens < t.inputTokens + t.outputTokens + cacheRead + cacheWrite);
  return {
    input: inside ? Math.max(0, t.inputTokens - cacheRead - cacheWrite) : t.inputTokens,
    output: t.outputTokens,
    cacheRead,
    cacheWrite,
    reasoning: t.reasoningOutputTokens,
  };
}

/** Folds one event into the state; true when it changed what a report reads. */
function fold(state: LedgerState, row: EventRow, harness: Harness, out: LedgerRecord[]): boolean {
  switch (row.type) {
    case "turn/started": {
      if (harness.separateChildCounters && row.scope.kind === "turn" && row.data.parentToolCallId) {
        state.childTurns ??= {};
        state.childTurns[row.scope.turnId] = row.data.parentToolCallId;
      }
      return false;
    }
    case "client/turn/requested": {
      const { data } = row;
      state.model = data.execution.model;
      // bb's own notices and steers into a running turn are not prompts; counting them would split turns.
      if (data.initiator === "system" || data.target.kind === "steer") return false;
      // Plugins add agent-only blocks, such as instructions, that the user never typed.
      const seen = data.input.filter((block) => !("visibility" in block && block.visibility === "agent-only"));
      out.push({ kind: "prompt", at: row.createdAt, text: promptExcerpt(seen) });
      return true;
    }
    case "item/started": {
      // A model call begins with the first item of its response; the items it spawns, such as tool output, are not new calls.
      if (!(CALL_ITEM_KINDS as readonly string[]).includes(row.data.item.type)) return false;
      const id = sessionId(state, row.data, row.scope);
      const session = sessionOf(state, id);
      if (session.callOpen) return false;
      state.sessions[id] = { ...session, callOpen: { at: row.createdAt } };
      return false;
    }
    case "provider/error": {
      // An error bb will retry is not a finished call; the retry's usage, or its final error, counts it.
      if (row.data.willRetry) return false;
      const id = sessionId(state, row.data, row.scope);
      const session = sessionOf(state, id);
      const open = session.callOpen;
      const ms = open ? row.createdAt - open.at : null;
      state.sessions[id] = { ...session, callOpen: null };
      out.push({ kind: "error", at: row.createdAt, session: id, model: state.model ?? UNKNOWN_MODEL, ...(ms !== null && ms >= 0 && ms <= MAX_CALL_MS ? { ms } : {}) });
      return true;
    }
    case "thread/tokenUsage/updated": {
      const { tokenUsage } = row.data;
      const id = sessionId(state, row.data, row.scope);
      const session = sessionOf(state, id);
      const { added, counters } = addedBy(countersOf(session), tokenUsage.total, tokenUsage.last);
      // A usage ends the call that is in flight; the span from that call's first item to here is its time.
      const open = session.callOpen;
      const ms = open ? row.createdAt - open.at : null;
      state.sessions[id] = { ...session, total: tokenUsage.total, earlier: counters.slice(1), callOpen: null };
      if (isZero(added)) return false;
      out.push({
        kind: "tokens",
        at: row.createdAt,
        session: id,
        model: state.model ?? UNKNOWN_MODEL,
        tokens: splitTokens(added, harness.cacheInInput),
        single: same(added, tokenUsage.last),
        ...(ms !== null && ms >= 0 && ms <= MAX_CALL_MS ? { ms } : {}),
      });
      return true;
    }
    case "thread/contextWindowUsage/updated": {
      const { contextWindowUsage } = row.data;
      const id = sessionId(state, row.data, row.scope);
      const { cost } = contextWindowUsage;
      if (cost === undefined) return false;
      const session = sessionOf(state, id);
      const usd = cost.currency === "USD";
      // A session's cost is cumulative; a drop means it started again.
      const gain = !usd ? 0 : session.usd === null || cost.amount < session.usd ? cost.amount : cost.amount - session.usd;
      state.sessions[id] = { ...session, usd: usd ? cost.amount : session.usd, costed: true };
      if (gain > 0) out.push({ kind: "cost", at: row.createdAt, session: id, model: state.model ?? UNKNOWN_MODEL, usd: gain });
      return gain > 0 || !session.costed;
    }
    default:
      return false;
  }
}

/**
 * Folds new events, oldest first, into the ledger. Returns the records they
 * added, or null when nothing a report reads changed; a session that first
 * records a cost is a change without a record.
 */
export function addRows(ledger: Ledger, rows: readonly EventRow[], harness: Harness): LedgerRecord[] | null {
  const { state } = ledger;
  const added: LedgerRecord[] = [];
  let changed = false;
  for (const row of rows) {
    if (state.afterSeq !== null && row.seq <= state.afterSeq) continue;
    state.afterSeq = row.seq;
    if (fold(state, row, harness, added)) {
      changed = true;
      state.at = row.createdAt;
    }
  }
  ledger.records.push(...added);
  return changed ? added : null;
}

const zeroCost = (): CostParts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

/**
 * The ledger as session log entries for buildReport. Tokens are priced here, not
 * when they arrive, so a cost that arrives later replaces their estimate.
 */
export function ledgerEntries(ledger: Ledger, providerId: string, harness: Harness): EntryLike[] {
  const { state } = ledger;
  return ledger.records.map((record) => {
    const timestamp = new Date(record.at).toISOString();
    switch (record.kind) {
      case "prompt":
        return { type: "message", timestamp, message: { role: "user", content: record.text } };
      case "tokens": {
        const { prices } = harness;
        const price = prices === null || sessionOf(state, record.session).costed ? null : priceOf(prices, record.model);
        const cost = price === null ? zeroCost() : listCost(price, record.tokens, { tiers: harness.perCall && record.single });
        const usage = { ...record.tokens, cost, estimated: price !== null };
        return { type: "message", timestamp, ...(record.session.includes(":child:") ? {agentId: record.session} : {}), message: { role: "assistant", provider: providerId, model: record.model, ...(record.ms !== undefined ? { durationMs: record.ms } : {}), usage } };
      }
      case "cost": {
        const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { ...zeroCost(), total: record.usd } };
        return { type: "usage", timestamp, ...(record.session.includes(":child:") ? {agentId: record.session} : {}), provider: providerId, model: record.model, usage };
      }
      case "error": {
        // A refused call spent nothing, but it is still a call: Burn counts it, as it counts opencode's failed calls.
        const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: zeroCost() };
        return { type: "message", timestamp, ...(record.session.includes(":child:") ? {agentId: record.session} : {}), message: { role: "assistant", provider: providerId, model: record.model, ...(record.ms !== undefined ? { durationMs: record.ms } : {}), stopReason: "error", usage } };
      }
    }
  });
}
