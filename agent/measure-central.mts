/**
 * Times uploads against the real Central + TiDB, not a mock.
 *
 * bench.mts measures the agent; this measures the far end. Same range, forced
 * to re-send (skipMatchingMonths:false) so every run does the same upsert work
 * and the numbers can be compared across builds.
 *
 *   npx tsx measure-central.mts [runs]
 */
process.env.AGENT_DATA_DIR = process.env.AGENT_DATA_DIR ?? "./data";

const RUNS = Number(process.argv[2] ?? 3);
const RANGE = {
  from: process.env.MEASURE_FROM ?? "2026-06-01",
  to: process.env.MEASURE_TO ?? "2026-08-08",
};

const { SyncRunner } = await import("./src/sync");

for (let run = 1; run <= RUNS; run++) {
  const runner = new SyncRunner();
  const started = Date.now();
  const result = await runner.run({
    mode: "MANUAL_RANGE",
    from: RANGE.from,
    to: RANGE.to,
    reconcile: false,
    skipMatchingMonths: false,
  });
  const elapsed = Date.now() - started;
  const t = (runner as unknown as { telemetry: Record<string, number> }).telemetry;
  console.log(
    JSON.stringify({
      run,
      rows: result.recordsSent,
      totalMs: elapsed,
      uploadRequests: t.uploadRequests,
      uploadMsTotal: t.uploadMsTotal,
      avgMs: t.uploadRequests ? Math.round(t.uploadMsTotal / t.uploadRequests) : 0,
    }),
  );
}
process.exit(0);
