import { describe, expect, test } from "vitest";
import { PRODUCT_NAME, formatPageTitle } from "./pageTitle";

describe("PRODUCT_NAME", () => {
  // The H5 audit's whole point: one spelling, and no shortened variant leaking
  // out of the two places (manifest short_name, iOS Home Screen title) that are
  // allowed to truncate it.
  test("is the full product name", () => {
    expect(PRODUCT_NAME).toBe("Corolla Fix Helper");
  });
});

describe("formatPageTitle", () => {
  test("suffixes the page name with the product name", () => {
    expect(formatPageTitle("Documents")).toBe("Documents | Corolla Fix Helper");
    expect(formatPageTitle("Ask AI")).toBe("Ask AI | Corolla Fix Helper");
    expect(formatPageTitle("Repair Planner")).toBe("Repair Planner | Corolla Fix Helper");
    expect(formatPageTitle("Repair Checklists")).toBe("Repair Checklists | Corolla Fix Helper");
    expect(formatPageTitle("Settings")).toBe("Settings | Corolla Fix Helper");
  });

  test("trims a padded page name rather than titling around the whitespace", () => {
    expect(formatPageTitle("  Notes  ")).toBe("Notes | Corolla Fix Helper");
  });

  // A missing or unusable label must not produce a dangling separator in the
  // browser tab.
  test("falls back to the bare product name when there is no usable page name", () => {
    for (const label of ["", "   ", null, undefined, 42, {}, []]) {
      expect(formatPageTitle(label)).toBe("Corolla Fix Helper");
    }
  });

  test("does not repeat the product name when the page is already named it", () => {
    expect(formatPageTitle("Corolla Fix Helper")).toBe("Corolla Fix Helper");
  });
});
