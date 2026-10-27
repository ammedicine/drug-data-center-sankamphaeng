import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AgentDetailsTable,
  AgentFleetStatusSummary,
  RunningSyncPanel,
  SyncSetupCard,
  SyncSetupScrollArea,
  SyncWorkspace,
} from "@/components/ui/sync-workspace";

const agent = {
  id: "agent-1",
  name: "For-dev",
  facilityCode: "05957",
  facilityName: "รพ.สต.สันกำแพง",
  hostname: "DEV-PC",
  effectiveStatus: "ONLINE" as const,
  jhcisState: "CONNECTED" as const,
  pendingBatches: 7,
  lastHeartbeatAt: new Date("2026-10-27T03:00:00Z"),
  lastSuccessfulSyncAt: new Date("2026-10-26T03:00:00Z"),
  lastSyncedVisitDate: "2026-10-26",
  lastError: "technical detail",
  action: createElement("button", null, "ซิงก์ข้อมูลตอนนี้"),
};

describe("sync monitoring workspace", () => {
  it("places a compact truthful Agent status summary in the reference position", () => {
    const html = renderToStaticMarkup(
      createElement(AgentFleetStatusSummary, {
        statuses: ["SYNCING", "ONLINE", "ONLINE", "OFFLINE", "ERROR", "DISABLED"],
        online: 3,
        totalAgents: 6,
        lastSyncLabel: "5 นาทีที่แล้ว",
        failedBatches24h: 1,
        facilitiesInScope: 2,
      }),
    );

    expect(html).toContain("สถานะ Agent (ปัจจุบัน)");
    expect(html).toContain("กำลังซิงก์");
    expect(html).toContain("ออนไลน์ (ปกติ)");
    expect(html).toContain("ออฟไลน์");
    expect(html).toContain("มีปัญหา");
    expect(html).toContain("ปิดใช้งาน");
    expect(html).toContain("ทั้งหมด");
    expect(html).toContain("2");
    expect(html).toContain("6");
    expect(html).toContain("Agent ออนไลน์");
    expect(html).toContain("ซิงก์ล่าสุด");
    expect(html).toContain("ซิงก์ล้มเหลว 24 ชม.");
    expect(html).toContain("สถานบริการในสิทธิ์");
  });

  it("keeps compact Agent detail facts and permission-safe errors below history", () => {
    const userHtml = renderToStaticMarkup(
      createElement(AgentDetailsTable, { agents: [agent], canSeeTechnical: false }),
    );
    const adminHtml = renderToStaticMarkup(
      createElement(AgentDetailsTable, { agents: [agent], canSeeTechnical: true }),
    );

    for (const text of [
      "For-dev",
      "05957 · รพ.สต.สันกำแพง",
      "JHCIS",
      "เชื่อมต่อแล้ว",
      "คิวค้างส่ง",
      "7 ชุด",
      "Heartbeat",
      "ซิงก์สำเร็จล่าสุด",
      "ข้อมูลล่าสุด",
      "ซิงก์ข้อมูลตอนนี้",
    ]) {
      expect(userHtml).toContain(text);
    }
    expect(userHtml).toContain("พบปัญหา กรุณาแจ้งผู้ดูแลระบบ");
    expect(userHtml).not.toContain("technical detail");
    expect(adminHtml).toContain("technical detail");
    expect(userHtml).toContain("table");
    expect(userHtml).toContain("max-h-[540px]");
    expect(userHtml).toContain("overflow-y-auto");
    expect(userHtml).toContain("sticky top-0");
  });

  it("stretches setup cards to equal height while their content fills the card", () => {
    const html = renderToStaticMarkup(
      createElement(SyncSetupCard, {
        title: "โปรแกรมเชื่อมข้อมูล JHCIS (Agent)",
        description: "ติดตั้ง Agent",
        icon: "download",
        children: createElement("div", null, "CONTENT"),
      }),
    );

    expect(html).toContain("h-full");
    expect(html).toContain("flex-col");
    expect(html).toContain("flex-1");
  });

  it("limits enrollment Agent rows to ten visible entries before scrolling", () => {
    const html = renderToStaticMarkup(
      createElement(
        SyncSetupScrollArea,
        null,
        ...Array.from({ length: 12 }, (_, index) => createElement("div", { key: index }, `Agent ${index + 1}`)),
      ),
    );

    expect(html).toContain('data-visible-agent-limit="10"');
    expect(html).toContain("max-h-[720px]");
    expect(html).toContain("overflow-y-auto");
  });

  it("shows truthful running progress and has no empty placeholder", () => {
    const runningHtml = renderToStaticMarkup(
      createElement(RunningSyncPanel, {
        batches: [
          {
            batchRef: "SYNC-20261027-000001",
            facilityCode: "05957",
            agentName: "For-dev",
            rangeFrom: "2026-10-01",
            rangeTo: "2026-10-26",
            recordsRead: 5574,
            recordsAccepted: 2500,
            recordsRejected: 0,
            progress: 2500 / 5574,
          },
        ],
      }),
    );
    const emptyHtml = renderToStaticMarkup(createElement(RunningSyncPanel, { batches: [] }));

    expect(runningHtml).toContain("กำลังนำเข้าข้อมูล");
    expect(runningHtml).toContain("SYNC-20261027-000001");
    expect(runningHtml).toContain("2,500 / 5,574");
    expect(runningHtml).toContain('role="progressbar"');
    expect(runningHtml).not.toContain("ETA");
    expect(emptyHtml).toBe("");
  });

  it("orders monitoring before history and setup", () => {
    const html = renderToStaticMarkup(
      createElement(SyncWorkspace, {
        header: createElement("div", null, "HEADER"),
        monitoring: createElement("div", null, "MONITORING"),
        agents: createElement("div", null, "AGENTS"),
        setup: createElement("div", null, "SETUP"),
      }),
    );

    expect(html.indexOf("HEADER")).toBeLessThan(html.indexOf("MONITORING"));
    expect(html.indexOf("MONITORING")).toBeLessThan(html.indexOf("AGENTS"));
    expect(html.indexOf("AGENTS")).toBeLessThan(html.indexOf("SETUP"));
  });
});
