import { describe, expect, it } from "vitest";

import { drugTypeLabel } from "@/lib/shared/drug-types";

describe("JHCIS drug type labels", () => {
  it.each([
    ["01", "ยาแผนปัจจุบัน"],
    ["02", "หัตถการ"],
    ["03", "วัสดุการแพทย์"],
    ["04", "ยาฯ คุมกำเนิด"],
    ["05", "วัคซีน"],
    ["06", "ค่าบริการฯ"],
    ["07", "ค่าตรวจ Lab"],
    ["10", "ยาสมุนไพร"],
    ["11", "เวชฯ มิใช่ยา"],
    ["91", "อื่นๆ"],
  ] as const)("maps JHCIS drugtype %s to its canonical label", (code, label) => {
    expect(drugTypeLabel(code)).toBe(label);
  });

  it("falls back safely for unknown and missing codes", () => {
    expect(drugTypeLabel("99")).toBe("ประเภท 99");
    expect(drugTypeLabel(null)).toBe("ไม่ระบุ");
    expect(drugTypeLabel(undefined)).toBe("ไม่ระบุ");
  });
});
