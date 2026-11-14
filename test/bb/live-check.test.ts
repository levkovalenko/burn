import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { ledgerEntries } from "../../extensions/bb/ledger.js";
import { buildReport } from "../../src/report.js";
import { harnessWithPrices } from "../../extensions/bb/harnesses.js";

const out: string[] = [];
const log = (...a: unknown[]) => out.push(a.join(" "));

/** Reads the live plugin database exactly as the event reader does. */
function liveReport(threadId: string) {
  const db = Database("/home/autowork/.bb/plugins/burn/data.db", { readonly: true });
  const row = db.prepare("SELECT state FROM usage_ledgers WHERE thread_id = ?").get(threadId) as { state: string } | undefined;
  const records = (db.prepare("SELECT record FROM usage_records WHERE thread_id = ? ORDER BY n").all(threadId) as { record: string }[]).map((r) => JSON.parse(r.record));
  const state = row ? JSON.parse(row.state) : { afterSeq: null, at: null, model: null, sessions: {} };
  const report = buildReport(ledgerEntries({ state, records }, "codex", harnessWithPrices("codex")), null);
  db.close();
  return report;
}

describe("live check", () => {
  it("prints", () => {
    const cost = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
    for (const t of ["thr_5te36te5f6", "thr_2gnxt9rh67", "thr_8ezz22c3vc", "thr_7ngqftx6y4", "thr_k4upd43ar4"]) {
      const r = liveReport(t);
      log("===", t);
      if (!r) {
        log("  no report");
        continue;
      }
      const lastDay = r.days.at(-1);
      log("  calls:", r.calls, "cost:", cost(r.cost).toFixed(4), "| lastDay calls/failed:", lastDay?.calls, lastDay?.failed);
      for (const m of r.byModel) log("  model:", m.key, "calls:", m.calls, "timed:", m.timed, "ms:", m.ms, "failed:", m.failed, "output:", m.output);
    }
    writeFileSync("/tmp/opencode/live-report.txt", out.join("\n") + "\n");
    expect(true).toBe(true);
  });
});
