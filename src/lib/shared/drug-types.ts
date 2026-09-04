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
 * The report is about ยา, and only three cdrug.drugtype values are medicines:
 * 01 ยาแผนปัจจุบัน, 05 วัคซีน, 10 ยาสมุนไพร. Everything else in cdrug is
 * supplies, equipment or service items and would inflate every total.
 */
export const PRIMARY_DRUG_TYPES = ["01", "05", "10"] as const;

export function isPrimaryDrugType(code: string | null | undefined): boolean {
  return Boolean(code) && (PRIMARY_DRUG_TYPES as readonly string[]).includes(code as string);
}

export function drugTypeLabel(code: string | null | undefined): string {
  if (!code) return "ไม่ระบุ";
  return DRUG_TYPE_LABELS[code] ?? `ประเภท ${code}`;
}
