import { describe, it, expect } from "vitest";
import { formatAmountPaid, formatCompleted } from "./reporting";

describe("formatCompleted", () => {
  it("reads as a count out of the enrolled students with a rate", () => {
    expect(formatCompleted(1, 4)).toBe("1 of 4 (25%)");
  });

  it("rounds the rate to a whole percent", () => {
    expect(formatCompleted(1, 3)).toBe("1 of 3 (33%)");
    expect(formatCompleted(2, 3)).toBe("2 of 3 (67%)");
  });

  it("shows 0% when students are enrolled but none completed", () => {
    expect(formatCompleted(0, 4)).toBe("0 of 4 (0%)");
  });

  it("shows no percentage with zero enrolled students", () => {
    expect(formatCompleted(0, 0)).toBe("0 of 0");
  });
});

describe("formatAmountPaid", () => {
  it("formats cents as US dollars", () => {
    expect(formatAmountPaid(35994)).toBe("$359.94");
  });

  it("shows zero as an amount, not as a free price", () => {
    expect(formatAmountPaid(0)).toBe("$0.00");
  });
});
