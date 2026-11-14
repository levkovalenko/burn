import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventReader } from "../../extensions/bb/events.js";
import { type EventRow, USAGE_EVENTS } from "../../extensions/bb/ledger.js";
import type { PriceOverrides } from "../../src/prices.js";
import { CODEX_1, CODEX_1_2, CODEX_2, errorEvent, event, itemEvent, listEvents, requestEvent, turnStartedEvent, usageEvent } from "./fixtures.js";

const T = "thr_aaaaaaaa";
const PI = "thr_pppppppp";
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

function setup(overrides?: () => PriceOverrides) {
  const rows: EventRow[] = [];
  let failing = false;
  let gate: Promise<void> | null = null;
  let now = 1_000_000;
  const { bb, harness } = createFakePluginHost({
    pluginId: "burn",
    sdk: {
      threads: {
        events: {
          list: async (args: Parameters<ReturnType<typeof listEvents>>[0]) => {
            if (failing) throw new Error("bb is restarting");
            if (gate) await gate;
            return listEvents(() => rows)(args);
          },
        },
      },
    },
  });
  disposers.push(() => harness.lifecycle.dispose());
  const changed: string[][] = [];
  const reader = () => createEventReader(bb, { onChange: (ids) => void changed.push(ids), now: () => now, ...(overrides ? { overrides } : {}) });
  const lists = () => harness.inspection.sdk.callsTo("threads.events.list").map(([args]) => args as Record<string, unknown>);
  const notice = (threadId: string, providerId: string) =>
    harness.behavior.emitThreadEvent("experimental_thread.events", { thread: makeThreadResponse({ id: threadId, providerId }), sequence: rows.length });
  const warnings = () => harness.inspection.logEntries.filter((e) => e.level === "warn").map((e) => e.message);
  const fail = (on: boolean) => {
    failing = on;
  };
  const hold = (): (() => void) => {
    let release = (): void => undefined;
    gate = new Promise((resolve) => {
      release = () => {
        gate = null;
        resolve();
      };
    });
    return release;
  };
  return { bb, rows, reader, changed, lists, notice, warnings, fail, hold, tick: (ms: number) => (now += ms) };
}

describe("createEventReader", () => {
  it("reads a thread's usage events once, then only those after the last it saved", async () => {
    const s = setup();
    const reader = s.reader();
    s.rows.push(requestEvent(T, "go", "gpt-5.5"), usageEvent(T, CODEX_1));
    const first = await reader.reportOf(T, "codex");
    expect(first?.report.cost.total).toBeCloseTo(0.053, 9);
    expect(first?.report.estimated).toBe(true);
    expect(first?.at).toBe(s.rows[1]?.createdAt);
    expect(s.lists()).toEqual([{ threadId: T, types: USAGE_EVENTS, order: "asc", limit: "100" }]);

    s.rows.push(usageEvent(T, CODEX_1_2, CODEX_2));
    expect((await reader.reportOf(T, "codex"))?.report.cost.total).toBeCloseTo(0.053, 9);
    reader.invalidate(T);
    expect((await reader.reportOf(T, "codex"))?.report.cost.total).toBeCloseTo(0.141, 9);
    expect(s.lists()[1]).toMatchObject({ afterSeq: String(s.rows[1]?.seq) });
    s.tick(60_000);
    await reader.reportOf(T, "codex");
    expect(s.lists()).toHaveLength(3);
    expect(s.lists()[2]).toMatchObject({ afterSeq: String(s.rows[2]?.seq) });
  });

  it("reads again after invalidateAll overtook a read in flight", async () => {
    const s = setup();
    s.rows.push(requestEvent(T, "go", "gpt-5.5"), usageEvent(T, CODEX_1));
    const reader = s.reader();
    const release = s.hold();
    const run = reader.reportOf(T, "codex");
    await vi.waitFor(() => expect(s.lists()).toHaveLength(1));
    reader.invalidateAll();
    release();
    await run;
    await reader.reportOf(T, "codex");
    expect(s.lists()).toHaveLength(2);
  });

  it("prices tokens with the settings' price overrides", async () => {
    const s = setup(() => ({ "gpt-5.5": { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }));
    s.rows.push(requestEvent(T, "go", "gpt-5.5"), usageEvent(T, CODEX_1));
    const got = await s.reader().reportOf(T, "codex");
    // CODEX_1 is 4,000 input, 6,000 cache reads and 1,000 output at $1 per million each.
    expect(got?.report.cost.total).toBeCloseTo(0.011, 9);
  });

  it("pages through more than a hundred events", async () => {
    const s = setup();
    for (let n = 0; n < 150; n++) s.rows.push(requestEvent(T, `prompt ${n}`, "gpt-5.5"));
    s.rows.push(usageEvent(T, CODEX_1));
    const got = await s.reader().reportOf(T, "codex");
    expect(got?.report.turnCount).toBe(150);
    expect(s.lists().map((args) => args.afterSeq)).toEqual([undefined, String(s.rows[99]?.seq)]);
  });

  it("gives a new reader the same figures from the database, without the events bb has since pruned", async () => {
    const s = setup();
    s.rows.push(requestEvent(T, "go", "gpt-5.5"), usageEvent(T, CODEX_1), usageEvent(T, CODEX_1_2, CODEX_2));
    const before = await s.reader().reportOf(T, "codex");
    s.rows.splice(1, 1);
    const after = await s.reader().reportOf(T, "codex");
    expect(after).toEqual(before);
    expect(s.lists()[1]).toMatchObject({ afterSeq: String(s.rows[1]?.seq) });
  });

  it("is null until the thread has used a model", async () => {
    const s = setup();
    const reader = s.reader();
    s.rows.push(requestEvent(T, "go", "gpt-5.5"));
    expect(await reader.reportOf(T, "codex")).toBeNull();
    s.rows.push(usageEvent(T, CODEX_1));
    reader.invalidate(T);
    expect(await reader.reportOf(T, "codex")).not.toBeNull();
  });

  it("names a thread whose usage changed when bb says it has new events, but not for other events, and ignores pi threads", async () => {
    const s = setup();
    s.reader();
    s.rows.push(requestEvent(T, "go", "gpt-5.5"), usageEvent(T, CODEX_1));
    await s.notice(T, "codex");
    expect(s.changed).toEqual([[T]]);
    s.rows.push(event(T, "item/agentMessage/delta", { delta: "streamed text" }));
    await s.notice(T, "codex");
    expect(s.changed).toEqual([[T]]);
    expect(s.lists()).toHaveLength(2);
    await s.notice(PI, "pi");
    expect(s.lists()).toHaveLength(2);
  });

  it("keeps the last report when a read fails, and logs the failure", async () => {
    const s = setup();
    const reader = s.reader();
    s.rows.push(requestEvent(T, "go", "gpt-5.5"), usageEvent(T, CODEX_1));
    const got = await reader.reportOf(T, "codex");
    s.fail(true);
    reader.invalidate(T);
    expect(await reader.reportOf(T, "codex")).toEqual(got);
    const { errors } = await s.notice(T, "codex");
    expect(errors).toEqual([]);
    expect(s.warnings()).toHaveLength(2);
    expect(s.warnings()[0]).toContain("bb is restarting");
    s.fail(false);
    s.rows.push(usageEvent(T, CODEX_1_2, CODEX_2));
    expect((await reader.reportOf(T, "codex"))?.report.cost.total).toBeCloseTo(0.141, 9);
  });

  it("forgets a thread's usage in memory and in the database", async () => {
    const s = setup();
    const reader = s.reader();
    s.rows.push(requestEvent(T, "go", "gpt-5.5"), usageEvent(T, CODEX_1));
    await reader.reportOf(T, "codex");
    await reader.forget(T);
    const db = s.bb.storage.database();
    expect(db.prepare("SELECT count(*) AS n FROM usage_records WHERE thread_id = ?").get(T)).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM usage_ledgers WHERE thread_id = ?").get(T)).toEqual({ n: 0 });
    s.rows.length = 0;
    expect(await reader.reportOf(T, "codex")).toBeNull();
    expect(s.lists().at(-1)?.afterSeq).toBeUndefined();
  });
});

describe("the call times the ledger reads from the item events", () => {
  it("times a call from the agent message that brackets it", async () => {
    const s = setup();
    const t0 = Date.now() - 1000;
    s.rows.push(
      requestEvent(T, "go", "gpt-5.5"),
      itemEvent(T, "i1", "reasoning", "s1", t0),
      itemEvent(T, "i2", "agentMessage", "s1", t0 + 1_000),
      usageEvent(T, CODEX_1, CODEX_1, "s1", t0 + 2_600),
    );
    const got = await s.reader().reportOf(T, "codex");
    expect(got?.report.byModel[0]).toMatchObject({ calls: 1, timed: 1, ms: 2_600, timedOutput: CODEX_1.outputTokens });
  });

  it("times no call whose response has no item the ledger reads, or that starts with tool output", async () => {
    const s = setup();
    const t0 = Date.now() - 1000;
    s.rows.push(requestEvent(T, "go", "gpt-5.5"), usageEvent(T, CODEX_1, CODEX_1, "s1", t0 + 500));
    let got = await s.reader().reportOf(T, "codex");
    expect(got?.report.byModel[0]).toMatchObject({ calls: 1, timed: 0, ms: 0 });

    const s2 = setup();
    const t1 = Date.now() - 1000;
    s2.rows.push(
      requestEvent(T, "go", "gpt-5.5"),
      event(T, "item/started", { providerThreadId: "s1", item: { type: "commandExecution", id: "c1" } }, t1),
      usageEvent(T, CODEX_1, CODEX_1, "s1", t1 + 1_000),
    );
    got = await s2.reader().reportOf(T, "codex");
    expect(got?.report.byModel[0]).toMatchObject({ calls: 1, timed: 0, ms: 0 });
  });

  it("leaves a call longer than five minutes untimed", async () => {
    const s = setup();
    const t0 = Date.now() - 10_000;
    s.rows.push(
      requestEvent(T, "go", "gpt-5.5"),
      itemEvent(T, "i1", "agentMessage", "s1", t0),
      usageEvent(T, CODEX_1, CODEX_1, "s1", t0 + 6 * 60_000),
    );
    const got = await s.reader().reportOf(T, "codex");
    expect(got?.report.byModel[0]).toMatchObject({ calls: 1, timed: 0, ms: 0 });
  });

  it("gives each usage to the call in flight, not one that ended before", async () => {
    const s = setup();
    const t0 = Date.now() - 10_000;
    s.rows.push(
      requestEvent(T, "go", "gpt-5.5"),
      itemEvent(T, "i1", "agentMessage", "s1", t0),
      usageEvent(T, CODEX_1, CODEX_1, "s1", t0 + 6 * 60_000),
      itemEvent(T, "i2", "agentMessage", "s1", t0 + 7 * 60_000),
      usageEvent(T, CODEX_1_2, CODEX_2, "s1", t0 + 7 * 60_000 + 500),
    );
    const got = await s.reader().reportOf(T, "codex");
    expect(got?.report.byModel[0]).toMatchObject({ calls: 2, timed: 1, ms: 500, timedOutput: CODEX_2.outputTokens });
  });

  it("counts a call the provider refused as a call that used no tokens", async () => {
    const s = setup();
    const t0 = Date.now() - 1000;
    s.rows.push(requestEvent(T, "go", "gpt-5.5"), errorEvent(T, { at: t0 }));
    const got = await s.reader().reportOf(T, "codex");
    expect(got?.report).toMatchObject({ calls: 1, cost: { total: 0 }, tokens: { output: 0 } });
    // A model that never used a token has no row of its own; the call still counts on the thread and the day.
    expect(got?.report.byModel).toEqual([]);
    expect(got?.report.turns[0]?.calls).toBe(1);
    expect(got?.report.days[0]).toMatchObject({ calls: 1, failed: 0 });
  });

  it("times a call the provider refused while it was in flight, and counts it failed", async () => {
    const s = setup();
    const t0 = Date.now() - 1000;
    s.rows.push(requestEvent(T, "go", "gpt-5.5"), itemEvent(T, "i1", "agentMessage", "s1", t0), errorEvent(T, { at: t0 + 8_000 }));
    const got = await s.reader().reportOf(T, "codex");
    expect(got?.report).toMatchObject({ calls: 1 });
    expect(got?.report.days[0]).toMatchObject({ calls: 1, failed: 1, callTime: [0, 0, 0, 0, 1, 0, 0, 0, 0] });
  });

  it("leaves a call bb will retry uncounted, and times the whole attempt when the retry answers", async () => {
    const s = setup();
    const t0 = Date.now() - 1000;
    s.rows.push(requestEvent(T, "go", "gpt-5.5"), itemEvent(T, "i1", "agentMessage", "s1", t0), errorEvent(T, { willRetry: true, at: t0 + 1_000 }));
    expect(await s.reader().reportOf(T, "codex")).toBeNull();
    s.rows.push(usageEvent(T, CODEX_1, CODEX_1, "s1", t0 + 3_100));
    const got = await s.reader().reportOf(T, "codex");
    expect(got?.report.byModel[0]).toMatchObject({ calls: 1, timed: 1, ms: 3_100, failed: 0 });
  });

  it("times a native child's call under the child's session", async () => {
    const s = setup();
    const t0 = Date.now() - 1000;
    const scope = { kind: "turn", turnId: "turn_1" } as const;
    s.rows.push(
      requestEvent(T, "go", "gpt-5.5"),
      turnStartedEvent(T, "turn_1", "tc_1"),
      itemEvent(T, "i1", "agentMessage", "s1", t0, scope),
      event(T, "thread/tokenUsage/updated", { providerThreadId: "s1", tokenUsage: { total: CODEX_1, last: CODEX_1, modelContextWindow: null } }, t0 + 2_100, scope),
    );
    const got = await s.reader().reportOf(T, "codex");
    expect(got?.report).toMatchObject({ calls: 1 });
    expect(got?.report.agents).toMatchObject({ coverage: "partial", rows: [{ id: "s1:child:tc_1", calls: 1 }] });
    expect(got?.report.byModel[0]).toMatchObject({ calls: 1, timed: 1, ms: 2_100 });
  });
});
