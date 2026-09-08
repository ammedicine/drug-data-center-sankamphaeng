/**
 * What "the page is showing something out of date" means, in one string.
 *
 * The status pages are server-rendered and then poll a light endpoint to
 * decide when they are worth rebuilding. That decision is a comparison, and a
 * comparison needs both sides to be produced the same way - so the server
 * building the page and the browser polling it both come here.
 *
 * It lives in its own module because of that: the client component is marked
 * "use client", and a page cannot call a function through that boundary and
 * expect it to run on the server.
 *
 * Timestamps arrive as Date objects on the server and as ISO strings in the
 * poll response, which is exactly how JSON hands them over, so they are
 * normalised rather than compared as they come.
 */

export interface SignatureAgent {
  id: string;
  /** The status a reader sees, which is effectiveStatus on the server rows. */
  status: string;
  jhcisState: string;
  lastHeartbeatAt: string | Date | null;
  lastSuccessfulSyncAt: string | Date | null;
  lastSyncedVisitDate: string | null;
  pendingBatches: number;
  version: string | null;
  lastError: string | null;
}

export interface SignatureBatch {
  batchRef: string;
  recordsAccepted: number;
  recordsRejected: number;
  progress: number;
}

/**
 * Whether a poll's answer means the page on screen is out of date.
 *
 * `previous` is what the page is showing: the server-rendered signature on the
 * first poll, and the last polled one after that. Null only when a caller
 * supplied no starting point, and then the first poll is taken as the baseline
 * rather than as news - which is what used to happen every time, and is how a
 * change between rendering and hydrating went unnoticed.
 */
export function shouldRefresh(previous: string | null, next: string): boolean {
  return previous !== null && previous !== next;
}

function moment(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Everything a reader would notice: which agents are up, whether JHCIS is
 * reachable, how far each run has got, and what is queued. Anything not in
 * here is deliberately not worth a page rebuild.
 */
export function liveSignature(input: {
  agents: SignatureAgent[];
  running: SignatureBatch[];
}): string {
  return JSON.stringify([
    input.agents.map((agent) => [
      agent.id,
      agent.status,
      agent.jhcisState,
      moment(agent.lastHeartbeatAt),
      moment(agent.lastSuccessfulSyncAt),
      agent.lastSyncedVisitDate,
      agent.pendingBatches,
      agent.version,
      agent.lastError,
    ]),
    input.running.map((batch) => [
      batch.batchRef,
      batch.recordsAccepted,
      batch.recordsRejected,
      batch.progress,
    ]),
  ]);
}
