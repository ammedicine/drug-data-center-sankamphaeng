"use client";

import { useEffect, useRef, useState } from "react";

import {
  LIVE_POLL_HIDDEN_SECONDS,
  LIVE_POLL_SECONDS,
  isFresh,
} from "@/lib/shared/agent-status";

export interface LiveAgent {
  id: string;
  name: string;
  facilityCode: string;
  facilityName: string;
  status: string;
  jhcisState: "CONNECTED" | "UNREACHABLE" | "UNKNOWN";
  version: string | null;
  hostname: string | null;
  ipAddress: string | null;
  macAddress: string | null;
  networkInterface: string | null;
  lastHeartbeatAt: string | null;
  lastJhcisCheckAt: string | null;
  lastSuccessfulSyncAt: string | null;
  lastSyncedVisitDate: string | null;
  pendingBatches: number;
  lastError: string | null;
  ownerName: string | null;
}

export interface LiveBatch {
  agentId: string;
  agentName: string;
  facilityCode: string;
  batchRef: string;
  rangeFrom: string | null;
  rangeTo: string | null;
  recordsRead: number;
  recordsAccepted: number;
  recordsRejected: number;
  progress: number;
  ownerName: string | null;
}

export interface LiveSnapshot {
  serverTime: string;
  agents: LiveAgent[];
  running: LiveBatch[];
}

/**
 * Keeps a page's status current without a reload.
 *
 * The pages are server-rendered, so what they show is true at the moment they
 * were requested and drifts from then on - which is why a sync could finish
 * and the screen still say it was running. This asks the server again on a
 * timer and hands back the answer.
 *
 * Polling slows right down while the tab is hidden. A dashboard left open on a
 * spare monitor for a week should not cost a request every five seconds for a
 * week, and nobody is reading it anyway; it catches up the moment the tab is
 * looked at again.
 */
export function useLiveStatus(initial?: LiveSnapshot | null) {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(
    initial ?? null,
  );
  const [stale, setStale] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      try {
        const response = await fetch("/api/sync/live", { cache: "no-store" });
        if (!response.ok) throw new Error(String(response.status));
        const data = (await response.json()) as LiveSnapshot;
        if (!cancelled) {
          setSnapshot(data);
          setStale(false);
        }
      } catch {
        // A failed poll leaves the last answer on screen and marks it as no
        // longer current, rather than blanking a page someone is reading.
        if (!cancelled) setStale(true);
      } finally {
        if (!cancelled) {
          const seconds =
            typeof document !== "undefined" &&
            document.visibilityState === "hidden"
              ? LIVE_POLL_HIDDEN_SECONDS
              : LIVE_POLL_SECONDS;
          timer.current = setTimeout(tick, seconds * 1000);
        }
      }
    };

    void tick();

    // Coming back to the tab should show current data immediately, not after
    // waiting out the slow interval it was using while hidden.
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        if (timer.current) clearTimeout(timer.current);
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return { snapshot, stale };
}

/** Small "as of" line, so a reader can see the page is keeping itself current. */
export function LiveIndicator({
  serverTime,
  stale,
}: {
  serverTime: string | null;
  stale: boolean;
}) {
  const [, force] = useState(0);

  // Re-render on a timer so "8 วินาทีที่แล้ว" keeps counting between polls.
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (!serverTime) return null;
  const seconds = Math.max(
    0,
    Math.round((Date.now() - Date.parse(serverTime)) / 1000),
  );
  const fresh = isFresh(serverTime);

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <span
        aria-hidden
        className={`size-1.5 rounded-full ${
          stale || !fresh ? "bg-warn" : "bg-ok"
        }`}
      />
      {stale
        ? "ติดต่อเซิร์ฟเวอร์ไม่ได้ ข้อมูลอาจไม่ใช่ล่าสุด"
        : `อัปเดตเมื่อ ${seconds} วินาทีที่แล้ว`}
    </span>
  );
}

/**
 * Makes a server-rendered page keep itself current.
 *
 * Polling the light endpoint and re-rendering the page only when something
 * actually changed keeps both costs down: the page's six-or-so database
 * queries run when there is news rather than every five seconds, and the
 * screen still never shows a finished sync as running.
 *
 * This deliberately does not take over the rendering. The tables stay server
 * components; this only decides when they are worth rebuilding.
 */
export function LiveRefresh({ router }: { router: { refresh: () => void } }) {
  const { snapshot, stale } = useLiveStatus();
  const lastSignature = useRef<string | null>(null);

  useEffect(() => {
    if (!snapshot) return;
    // Everything a reader would notice: which agents are up, whether JHCIS is
    // reachable, how far each run has got, and what is queued.
    const signature = JSON.stringify([
      snapshot.agents.map((a) => [
        a.id,
        a.status,
        a.jhcisState,
        a.lastHeartbeatAt,
        a.lastSuccessfulSyncAt,
        a.lastSyncedVisitDate,
        a.pendingBatches,
        a.version,
        a.lastError,
      ]),
      snapshot.running.map((b) => [
        b.batchRef,
        b.recordsAccepted,
        b.recordsRejected,
        b.progress,
      ]),
    ]);

    if (lastSignature.current !== null && lastSignature.current !== signature) {
      router.refresh();
    }
    lastSignature.current = signature;
  }, [snapshot, router]);

  return (
    <LiveIndicator serverTime={snapshot?.serverTime ?? null} stale={stale} />
  );
}
