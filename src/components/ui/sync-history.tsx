import { CellMeta, DataTable } from "@/components/ui/data-table";
import {
  Card,
  StatusBadge,
  formatDate,
  formatDateTime,
  formatNumber,
} from "@/components/ui/primitives";
import type { SyncBatchRow } from "@/lib/services/monitoring";

const MODE_LABELS: Record<string, string> = {
  INITIAL: "ซิงก์ครั้งแรก",
  INCREMENTAL: "ซิงก์ต่อเนื่อง",
  MANUAL_RANGE: "เลือกช่วงเอง",
  RETRY: "ส่งซ้ำ",
};

/** Shared sync-history table used by /sync and /admin/monitoring. */
export function SyncHistoryCard({
  batches,
  title = "ประวัติการซิงก์",
  description,
  showFacility = true,
  showTechnicalError = false,
}: {
  batches: SyncBatchRow[];
  title?: string;
  description?: string;
  showFacility?: boolean;
  showTechnicalError?: boolean;
}) {
  return (
    <Card title={title} description={description}>
      <DataTable
        rowKey={(row) => row.id}
        rows={batches}
        emptyTitle="ยังไม่มีประวัติการซิงก์"
        emptyDescription="ประวัติจะปรากฏหลัง Agent เริ่มส่งข้อมูลเข้าสู่ระบบ"
        columns={[
          {
            key: "batch",
            header: "รอบการซิงก์",
            render: (row) => (
              <>
                <span className="numeric text-[13.5px] text-ink">{row.batchRef}</span>
                <CellMeta>
                  {MODE_LABELS[row.mode] ?? row.mode} · {row.agentName}
                </CellMeta>
              </>
            ),
          },
          ...(showFacility
            ? [
                {
                  key: "facility",
                  header: "สถานบริการ",
                  render: (row: SyncBatchRow) => (
                    <span className="text-[13px] text-muted">
                      {row.facilityCode} · {row.facilityName}
                    </span>
                  ),
                  hideBelow: "md" as const,
                },
              ]
            : []),
          {
            key: "range",
            header: "ช่วงข้อมูลที่อ่าน",
            // The range was stored on every batch from the start and never
            // shown, so history could say a run moved 4,650 rows without
            // saying which days those rows were from.
            render: (row) =>
              row.rangeFrom && row.rangeTo ? (
                <span className="whitespace-nowrap text-xs text-muted">
                  {formatDate(row.rangeFrom)} – {formatDate(row.rangeTo)}
                </span>
              ) : (
                <span className="text-xs text-muted">-</span>
              ),
          },
          {
            key: "started",
            header: "เริ่ม",
            render: (row) => (
              <span className="text-[13px] text-muted">{formatDateTime(row.startedAt)}</span>
            ),
            hideBelow: "sm",
          },
          {
            key: "read",
            header: "อ่านได้",
            align: "right",
            render: (row) => formatNumber(row.recordsRead),
          },
          {
            key: "accepted",
            header: "บันทึกสำเร็จ",
            align: "right",
            render: (row) => formatNumber(row.recordsAccepted),
          },
          {
            key: "rejected",
            header: "ถูกปฏิเสธ",
            align: "right",
            render: (row) =>
              row.recordsRejected ? (
                <span className="text-danger">{formatNumber(row.recordsRejected)}</span>
              ) : (
                "0"
              ),
          },
          {
            key: "status",
            header: "สถานะ",
            render: (row) => (
              <>
                <StatusBadge status={row.status} />
                {showTechnicalError && row.errorMessage ? (
                  <span
                    className="mt-1 block max-w-[280px] truncate text-xs text-danger"
                    title={row.errorMessage}
                  >
                    {row.errorMessage}
                  </span>
                ) : null}
              </>
            ),
          },
        ]}
      />
    </Card>
  );
}
