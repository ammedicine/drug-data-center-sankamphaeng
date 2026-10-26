import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  DrugTypeMultiSelect,
  DrugUsageReportViews,
  DrugUsageSearchInput,
  DrugUsageSearchProvider,
} from "@/components/ui/drug-usage-report-workspace";

describe("drug usage report workspace", () => {
  it("renders one compact category control with the real selected values", () => {
    const html = renderToStaticMarkup(
      createElement(DrugTypeMultiSelect, {
        options: ["01", "10", "05"],
        selected: ["01", "10"],
        primaryTypes: ["01", "10"],
      }),
    );

    expect(html).toContain("หมวดยา");
    expect(html).toContain("01 ยาแผนปัจจุบัน, 10 ยาสมุนไพร");
    expect(html.match(/name="types"/g)).toHaveLength(3);
    expect(html).toContain("05 วัคซีน");
  });

  it("renders the shared instant search once with the approved placeholder", () => {
    const html = renderToStaticMarkup(
      createElement(
        DrugUsageSearchProvider,
        { initialQuery: "" },
        createElement(DrugUsageSearchInput),
      ),
    );

    expect(html.match(/type="search"/g)).toHaveLength(1);
    expect(html).toContain("ค้นหาชื่อยา หรือรหัสยา...");
  });

  it("opens the drug list as the default report view", () => {
    const html = renderToStaticMarkup(
      createElement(DrugUsageReportViews, {
        dateContext: "ข้อมูล 2026-06-01 ถึง 2026-08-31",
        listView: createElement("div", null, "LIST_VIEW"),
        categoryView: createElement("div", null, "CATEGORY_VIEW"),
      }),
    );

    expect(html).toContain("รายการยา");
    expect(html).toContain("สรุปตามหมวดยา");
    expect(html).toContain("LIST_VIEW");
    expect(html).not.toContain("CATEGORY_VIEW");
  });
});
