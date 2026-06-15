import { describe, it, expect } from "vitest";
import { formatDate, getSortTimestamp } from "./formatDate.js";

describe("formatDate", () => {
  it("returns 'Not available' for empty or invalid values", () => {
    expect(formatDate("")).toBe("Not available");
    expect(formatDate(null)).toBe("Not available");
    expect(formatDate(undefined)).toBe("Not available");
    expect(formatDate("not a date")).toBe("Not available");
  });

  it("formats a valid timestamp into a non-empty localized string", () => {
    const formatted = formatDate("2026-06-15T05:22:52Z");
    expect(formatted).not.toBe("Not available");
    expect(formatted).toContain("2026");
  });
});

describe("getSortTimestamp", () => {
  it("prefers updatedAt over createdAt", () => {
    const entity = {
      updatedAt: "2026-06-15T00:00:00Z",
      createdAt: "2020-01-01T00:00:00Z",
    };
    expect(getSortTimestamp(entity)).toBe(new Date("2026-06-15T00:00:00Z").getTime());
  });

  it("falls back to createdAt when updatedAt is missing", () => {
    const entity = { createdAt: "2020-01-01T00:00:00Z" };
    expect(getSortTimestamp(entity)).toBe(new Date("2020-01-01T00:00:00Z").getTime());
  });

  it("returns 0 when no usable timestamp exists", () => {
    expect(getSortTimestamp({})).toBe(0);
    expect(getSortTimestamp({ updatedAt: "nonsense" })).toBe(0);
  });
});
