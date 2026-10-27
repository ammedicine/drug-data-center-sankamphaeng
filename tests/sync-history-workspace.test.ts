import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  SyncHistoryWorkspace,
  filterSyncBatches,
  groupSyncActivity,
  summarizeSyncBatches,
  type SyncBatchPresentation,
} from "@/components/ui/sync-history-workspace";

const rows: SyncBatchPresentation[] = [
  {
    id: "1",
    batchRef: "SYNC-A",
    facilityCode: "05957",
    facilityName: "สันกำแพง",
    agentName: "For-dev",
    mode: "INCREMENTAL",
    status: "COMPLETED",
    rangeFrom: "2026-10-01",
    rangeTo: "2026-10-20",
    startedAt: "2026-10-26T03:00:00.000Z",
    recordsRead: 100,
    recordsAccepted: 100,
    recordsRejected: 0,
    errorMessage: null,
  },
  {
    id: "2",
    batchRef: "SYNC-B",
    facilityCode: "05957",
    facilityName: "สันกำแพง",
    agentName: "ห้องยา pod",
    mode: "MANUAL_RANGE",
    status: "UPLOADING",
    rangeFrom: "2026-10-21",
    rangeTo: "2026-10-25",
    startedAt: "2026-10-27T02:00:00.000Z",
    recordsRead: 50,
    recordsAccepted: 20,
    recordsRejected: 0,
    errorMessage: null,
  },
  {
    id: "3",
    batchRef: "SYNC-C",
    facilityCode: "05959",
    facilityName: "แม่ผาแหน",
    agentName: "เครื่องฉลาก",
    mode: "RETRY",
    status: "FAILED",
    rangeFrom: null,
    rangeTo: null,
    startedAt: "2026-10-27T04:00:00.000Z",
    recordsRead: 10,
    recordsAccepted: 0,
    recordsRejected: 0,
    errorMessage: "network",
  },
  {
    id: "4",
    batchRef: "SYNC-D",
    facilityCode: "05954",
    facilityName: "ชุตติภัทร",
    agentName: "legacy",
    mode: "INITIAL",
    status: "ABORTED",
    rangeFrom: null,
    rangeTo: null,
    startedAt: "2026-10-25T04:00:00.000Z",
    recordsRead: 5,
    recordsAccepted: 5,
    recordsRejected: 0,
    errorMessage: null,
  },
];

describe("sync history workspace", () => {
  it("filters only the already-loaded rows by all approved fields", () => {
    expect(filterSyncBatches(rows, { from: "2026-10-27", to: "", facility: "", status: "", mode: "", search: "" }))
      .toHaveLength(2);
    expect(filterSyncBatches(rows, { from: "", to: "", facility: "05959", status: "FAILED", mode: "RETRY", search: "ฉลาก" }))
      .toEqual([rows[2]]);
    expect(filterSyncBatches(rows, { from: "", to: "", facility: "", status: "", mode: "", search: "sync-a" }))
      .toEqual([rows[0]]);
  });

  it("summarizes exact schema statuses without treating ABORTED as FAILED", () => {
    expect(summarizeSyncBatches(rows)).toEqual({
      total: 4,
      completed: 1,
      inProgress: 1,
      failed: 1,
    });
  });

  it("groups truthful daily activity from loaded timestamps", () => {
    expect(groupSyncActivity(rows)).toEqual([
      { date: "2026-10-25", completed: 0, inProgress: 0, failed: 0, other: 1 },
      { date: "2026-10-26", completed: 1, inProgress: 0, failed: 0, other: 0 },
      { date: "2026-10-27", completed: 0, inProgress: 1, failed: 1, other: 0 },
    ]);
  });

  it("renders the locked filter, KPI, operational, chart, and history hierarchy", () => {
    const html = renderToStaticMarkup(
      createElement(SyncHistoryWorkspace, {
        batches: rows,
        showFacility: true,
        showTechnicalError: true,
        agentSummary: createElement("div", null, "สถานะ Agent (ปัจจุบัน)"),
        runningSync: null,
      }),
    );

    for (const text of [
      "ค้นหาและกรองข้อมูล",
      "วันที่เริ่ม",
      "วันที่สิ้นสุด",
      "สถานบริการ",
      "สถานะ",
      "ประเภทการซิงก์",
      "ค้นหา Batch / Agent / สถานบริการ",
      "ล้างค่า",
      "สรุปจากประวัติ 50 รอบล่าสุด",
      "รอบการซิงก์",
      "สำเร็จ",
      "กำลังดำเนินการ",
      "ล้มเหลว",
      "สถานะ Agent (ปัจจุบัน)",
      "กิจกรรมจาก 50 รอบการซิงก์ล่าสุด",
      "ประวัติการซิงก์ข้อมูล",
      "วันที่เริ่ม",
      "เวลา",
      "ประเภทข้อมูล",
      "จำนวนรายการ",
      "Batch ID",
      "SYNC-A",
    ]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain("30 วันที่ผ่านมา");
    expect(html).not.toContain("ค้นหา</button>");
  });
});
