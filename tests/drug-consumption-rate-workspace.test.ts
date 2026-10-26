import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ConsumptionRateFilterPanel,
  ConsumptionRateField,
  ConsumptionRateKpiGrid,
} from "@/components/ui/drug-consumption-rate-workspace";
import { AverageUsageTable } from "@/components/ui/average-usage-table";

describe("drug consumption rate workspace", () => {
  it("keeps long row-one labels on one aligned desktop line", () => {
    const html = renderToStaticMarkup(
      createElement(
        ConsumptionRateField,
        {
          label: "ตัวคูณระยะเวลา / สำรองคงคลัง (เดือน)",
          hint: "จำนวนเดือนที่ต้องการสำรองจากอัตราการใช้เฉลี่ย",
          children: createElement("input", { name: "reserveMonths" }),
        },
      ),
    );

    expect(html).toContain("ตัวคูณระยะเวลา / สำรองคงคลัง (เดือน)");
    expect(html).toContain("xl:whitespace-nowrap");
    expect(html).toContain("reserveMonths");
  });

  it("keeps the four real filters, categories, and actions in the approved hierarchy", () => {
    const html = renderToStaticMarkup(
      createElement(ConsumptionRateFilterPanel, {
        resetHref: "/reports/drug-consumption-rate",
        note: "ขอบเขตจริง",
        fields: createElement(
          "div",
          null,
          "เดือนเริ่มต้น เดือนสิ้นสุด ตัวคูณระยะเวลา / สำรองคงคลัง (เดือน) สถานบริการ",
        ),
        categories: createElement("div", null, "01 ยาแผนปัจจุบัน 10 ยาสมุนไพร"),
      }),
    );

    expect(html).toContain("เลือกเงื่อนไขและช่วงข้อมูล");
    expect(html).toContain("เดือนเริ่มต้น เดือนสิ้นสุด ตัวคูณระยะเวลา / สำรองคงคลัง (เดือน) สถานบริการ");
    expect(html).toContain("หมวดยา");
    expect(html).toContain("01 ยาแผนปัจจุบัน 10 ยาสมุนไพร");
    expect(html).toContain("คำนวณ");
    expect(html).toContain("ค่าเริ่มต้น");
    expect(html).toContain("ขอบเขตจริง");
    expect(html).not.toContain("รีเฟรช");
  });

  it("renders exactly the four approved real KPI metrics", () => {
    const html = renderToStaticMarkup(
      createElement(ConsumptionRateKpiGrid, {
        monthCount: 3,
        distinctDrugs: 151,
        totalQuantity: 130304,
        averageTotalPerMonth: "43,434.67",
      }),
    );

    expect(html).toContain("ช่วงที่คำนวณ");
    expect(html).toContain("จำนวนรายการยา");
    expect(html).toContain("ปริมาณใช้รวม");
    expect(html).toContain("เฉลี่ยการใช้ต่อเดือนทั้งหมด");
    expect(html.match(/data-consumption-kpi=/g)).toHaveLength(4);
    expect(html).not.toContain("ผู้ป่วย");
    expect(html).not.toContain("%");
  });

  it("places the title, real context, search, sort, and table in one report surface", () => {
    const html = renderToStaticMarkup(
      createElement(AverageUsageTable, {
        context: "ช่วง 2026-06 ถึง 2026-08 · 3 เดือน · ตัวคูณ 1.5 เดือน",
        rows: [
          {
            drugCode: "P138",
            drugName: "METFORMIN 500 MG TAB",
            drugType: "01",
            unit: "เม็ด",
            totalQuantity: 21308,
            monthCount: 3,
            averagePerMonth: 7102.67,
            reserveMonths: 1.5,
            recommendedReserveQuantity: 10654,
          },
        ],
      }),
    );

    expect(html).toContain("อัตราการใช้ยาเฉลี่ยต่อเดือน รายรายการ");
    expect(html).toContain("ช่วง 2026-06 ถึง 2026-08 · 3 เดือน · ตัวคูณ 1.5 เดือน");
    expect(html.match(/type="search"/g)).toHaveLength(1);
    expect(html).toContain("เรียงลำดับ");
    expect(html).toContain("พบ 1 รายการ");
    expect(html).toContain("ปริมาณสำรองที่แนะนำ");
    expect(html).toContain("P138");
  });
});
