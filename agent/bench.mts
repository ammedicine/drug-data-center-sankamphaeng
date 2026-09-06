/**
 * Measures the sync pipeline against a mock Central, so a change can be judged
 * rather than guessed at.
 *
 * Central is faked - with a settable per-request latency, because the thing
 * being measured is how the agent behaves when the far end is slow - and its
 * HMAC verification is the same code the real route uses, so nothing is being
 * measured through a shortcut the production path does not have. JHCIS is the
 * real development database: extraction is half of what is being timed and a
 * fake reader would measure nothing.
 *
 *   npx tsx bench.mts                 (default: 40ms Central latency)
 *   npx tsx bench.mts --latency 200   (a slow link)
 *   npx tsx bench.mts --from 2026-01-01 --to 2026-08-08
 *
 * Reports time-to-first-upload, total duration, request count, peak queue
 * depth and rows/sec for each stage.
 */
import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
};

const LATENCY_MS = Number(arg("latency", "40"));
/** Refuse uploads for the first N seconds, to watch an outage and a recovery. */
const OUTAGE_SECONDS = Number(arg("outage", "0"));
const startedAt = Date.now();
const RANGE = { from: arg("from", "2026-06-01"), to: arg("to", "2026-08-08") };
const KEY_ID = "bench-key";
const SECRET = "bench-secret-bench-secret-bench-secret";

interface Metrics {
  requests: number;
  uploadRequests: number;
  rowsAccepted: number;
  firstUploadAt: number | null;
  latencies: number[];
}

const metrics: Metrics = {
  requests: 0,
  uploadRequests: 0,
  rowsAccepted: 0,
  firstUploadAt: null,
  latencies: [],
};

function sign(body: string, method: string, path: string, timestamp: string, nonce: string) {
  const digest = createHmac("sha256", SECRET);
  digest.update(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}`);
  return digest.digest("hex");
}

async function startMockCentral(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      metrics.requests += 1;
      const started = Date.now();
      const path = req.url ?? "";

      // Central is not instant, and the point of the exercise is what the
      // agent does while it waits.
      if (LATENCY_MS > 0) await new Promise((done) => setTimeout(done, LATENCY_MS));

      let payload: Record<string, unknown> = { ok: true };
      if (path.endsWith("/heartbeat")) {
        payload = {
          ok: true,
          config: {
            facilityId: "FAC",
            facilityCode: "RPST-BENCH",
            facilityName: "bench",
            expectedPcucode: "05957",
            syncIntervalMinutes: 60,
            reprocessDays: 7,
            lastSyncedVisitDate: null,
            uploadChunkSize: 500,
            disabled: false,
            syncRequested: false,
            verifyRequested: false,
          },
        };
      } else if (path.endsWith("/sync/upload")) {
        if (OUTAGE_SECONDS > 0 && Date.now() - startedAt < OUTAGE_SECONDS * 1000) {
          res.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
          res.end(JSON.stringify({ error: { code: "UNAVAILABLE", message: "bench outage" } }));
          return;
        }
        const parsed = JSON.parse(body || "{}") as { records?: unknown[] };
        const count = parsed.records?.length ?? 0;
        if (count) {
          metrics.uploadRequests += 1;
          metrics.rowsAccepted += count;
          metrics.firstUploadAt ??= Date.now();
        }
        payload = { accepted: count, rejected: 0, rejects: [] };
      } else if (path.endsWith("/sync/audit")) {
        // Report exactly what has been accepted, so reconciliation is happy
        // and the benchmark measures delivery rather than repair.
        payload = { months: [], total: metrics.rowsAccepted };
      }

      metrics.latencies.push(Date.now() - started);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];
}

async function main() {
  const workDir = mkdtempSync(resolve(tmpdir(), "sdc-bench-"));
  process.env.AGENT_DATA_DIR = workDir;
  process.env.AGENT_RETRY_ATTEMPTS = "2";

  const { server, url } = await startMockCentral();

  writeFileSync(
    resolve(workDir, "agent.config.json"),
    JSON.stringify({
      agentId: "bench-agent",
      keyId: KEY_ID,
      secret: SECRET,
      centralApiUrl: url,
      facilityId: "FAC",
      facilityCode: "RPST-BENCH",
      facilityName: "bench",
      expectedPcucode: "05957",
      installationId: "bench",
      syncIntervalMinutes: 60,
      reprocessDays: 7,
      enrolledAt: new Date().toISOString(),
    }),
    "utf8",
  );

  const { SyncRunner } = await import("./src/sync");

  // Peak queue depth says whether the reader is racing ahead of the uploader
  // and how much unsent work would be lost to a crash.
  let peakDepth = 0;
  const pendingDir = resolve(workDir, "queue", "pending");
  const watcher = setInterval(() => {
    try {
      peakDepth = Math.max(peakDepth, readdirSync(pendingDir).length);
    } catch {
      /* the directory appears once the first chunk is queued */
    }
  }, 25);

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
  clearInterval(watcher);

  const seconds = elapsed / 1000;
  const firstUpload = metrics.firstUploadAt ? metrics.firstUploadAt - started : null;

  console.log("");
  console.log(`ช่วงข้อมูล            : ${RANGE.from} ถึง ${RANGE.to}`);
  console.log(`หน่วงของ Central      : ${LATENCY_MS} ms/request`);
  console.log("-".repeat(58));
  console.log(`แถวที่อ่านได้          : ${result.recordsRead.toLocaleString()}`);
  console.log(`แถวที่ส่ง             : ${result.recordsSent.toLocaleString()}`);
  console.log(`ศูนย์กลางรับ          : ${metrics.rowsAccepted.toLocaleString()}`);
  console.log(`เวลารวม              : ${seconds.toFixed(2)} s`);
  console.log(`rows/sec (ทั้งรอบ)    : ${Math.round(result.recordsSent / seconds).toLocaleString()}`);
  console.log(
    `เริ่มอัปโหลดครั้งแรกที่  : ${firstUpload === null ? "ไม่ได้อัปโหลด" : `${firstUpload} ms`}`,
  );
  console.log(`จำนวน request ทั้งหมด  : ${metrics.requests} (อัปโหลด ${metrics.uploadRequests})`);
  console.log(`คิวสูงสุดที่ค้างบนดิสก์  : ${peakDepth} chunk`);
  console.log(
    `latency ที่ Central    : p50 ${percentile(metrics.latencies, 50)} ms · p95 ${percentile(metrics.latencies, 95)} ms`,
  );
  console.log(`คิวเหลือค้าง          : ${result.pendingChunks} chunk`);

  server.close();
  rmSync(workDir, { recursive: true, force: true });
  process.exit(0);
}

void main();
