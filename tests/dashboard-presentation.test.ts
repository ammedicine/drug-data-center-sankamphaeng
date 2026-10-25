import { describe, expect, it } from "vitest";

import { percentOfTotal } from "@/lib/shared/dashboard-presentation";

describe("dashboard presentation helpers", () => {
  it("calculates a one-decimal percentage from real totals", () => {
    expect(percentOfTotal(2_098, 8_632)).toBe(24.3);
  });

  it("returns zero when the total is missing or zero", () => {
    expect(percentOfTotal(10, 0)).toBe(0);
    expect(percentOfTotal(10, Number.NaN)).toBe(0);
  });

  it("keeps progress widths inside the visual range", () => {
    expect(percentOfTotal(-5, 100)).toBe(0);
    expect(percentOfTotal(150, 100)).toBe(100);
  });
});
