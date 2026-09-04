/**
 * Drug category vocabulary (cdrug.drugtype).
 *
 * Kept separate from canonical.ts on purpose: this module is imported by client
 * components, and canonical.ts pulls in node:crypto, which cannot be bundled
 * for the browser.
 */

/** JHCIS drug types we understand; anything else is passed through as-is. */
export const DRUG_TYPE_LABELS: Record<string, string> = {
  "01": "ยาแผนปัจจุบัน",
  "02": "เวชภัณฑ์มิใช่ยา",
  "03": "วัสดุการแพทย์",
  "04": "วัสดุทันตกรรม",
  "05": "วัคซีน",
  "06": "หัตถการ/บริการ",
  "07": "วัสดุวิทยาศาสตร์",
  "10": "ยาสมุนไพร",
  "11": "ครุภัณฑ์/อื่น ๆ",
  "91": "อื่น ๆ",
};

/**
 * The report is about ยาที่จ่ายให้ผู้ป่วย: 01 ยาแผนปัจจุบัน และ 10 ยาสมุนไพร.
 *
 * 05 วัคซีน is deliberately NOT here. Immunisation is recorded and reported
 * through EPI, which this system does not cover, so counting vaccine codes
 * alongside dispensed medicine would double-report them. The agent still syncs
 * every category, and SUPER_ADMIN can tick 05 (or any other category) on the
 * report filter when they need to look at it - it is hidden by default, not
 * discarded.
 *
 * Everything else in cdrug is supplies, equipment or service items and would
 * inflate every total.
 */
export const PRIMARY_DRUG_TYPES = ["01", "10"] as const;

export function isPrimaryDrugType(code: string | null | undefined): boolean {
  return Boolean(code) && (PRIMARY_DRUG_TYPES as readonly string[]).includes(code as string);
}

export function drugTypeLabel(code: string | null | undefined): string {
  if (!code) return "ไม่ระบุ";
  return DRUG_TYPE_LABELS[code] ?? `ประเภท ${code}`;
}

/**
 * How a drug code's cdrug.drugflag reads on screen.
 *
 * flag "2" is a code the facility switched off. A missing master row is NOT the
 * same as an open code - it means the drug master has not been synced for that
 * code yet - so it gets its own label rather than being flattered into
 * "เปิดใช้งาน", which is what used to happen.
 *
 * `rank` is the sort key every listing uses: open codes first, unknown next,
 * closed codes at the bottom.
 */
export type DrugStatus = {
  rank: 0 | 1 | 2;
  label: string;
  className: string;
};

export function drugStatus(flag: string | null | undefined): DrugStatus {
  if (flag === "2") return { rank: 2, label: "ปิดใช้งาน", className: "bg-warn-soft text-warn" };
  if (!flag) return { rank: 1, label: "ไม่ทราบสถานะ", className: "bg-raised text-muted" };
  return { rank: 0, label: "เปิดใช้งาน", className: "bg-ok-soft text-ok" };
}
