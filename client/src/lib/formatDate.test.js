import { describe, it, expect } from "vitest";
import {
  formatDate,
  getSortTimestamp,
  normalizeSqliteTimestamp,
} from "./formatDate.js";

describe("normalizeSqliteTimestamp", () => {
  it("marks a bare SQLite timestamp (UTC, no zone) as explicit UTC", () => {
    // SQLite CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" in UTC; JS parses that
    // space-separated form as LOCAL time, so it must be marked UTC.
    expect(normalizeSqliteTimestamp("2026-01-15 12:00:00")).toBe("2026-01-15T12:00:00Z");
  });

  it("leaves ISO strings that already carry a zone untouched", () => {
    expect(normalizeSqliteTimestamp("2026-06-15T05:22:52Z")).toBe("2026-06-15T05:22:52Z");
  });

  it("passes non-timestamp values through unchanged", () => {
    expect(normalizeSqliteTimestamp("")).toBe("");
    expect(normalizeSqliteTimestamp(null)).toBe(null);
  });
});

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

  it("treats a bare SQLite timestamp as UTC when sorting", () => {
    expect(getSortTimestamp({ updatedAt: "2026-01-15 12:00:00" })).toBe(
      Date.UTC(2026, 0, 15, 12, 0, 0)
    );
  });
});
