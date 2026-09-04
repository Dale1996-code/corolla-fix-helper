import { describe, it, expect } from "vitest";
import {
  formatCalendarDate,
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

describe("formatCalendarDate", () => {
  it("formats a bare YYYY-MM-DD as a short calendar date", () => {
    expect(formatCalendarDate("2026-08-20")).toBe("Aug 20, 2026");
  });

  // The reason this helper exists at all. `new Date("2026-08-20")` is UTC
  // midnight, which Intl then renders in the VIEWER's zone -- so anywhere west
  // of Greenwich the repair recorded on the 20th read as the 19th.
  //
  // Asserted by comparing against both renderings rather than by mutating TZ,
  // which a running Node process does not reliably apply to an already-resolved
  // Intl default. On a UTC runner the two agree and the first assertion is the
  // whole test; on a runner behind UTC they diverge and the second pins which
  // side of the divergence the helper is on.
  it("renders the calendar day in UTC, not in the viewer's zone", () => {
    const dateOptions = { year: "numeric", month: "short", day: "numeric" };
    const utcRender = new Intl.DateTimeFormat(undefined, {
      ...dateOptions,
      timeZone: "UTC",
    }).format(new Date(Date.UTC(2026, 7, 20)));
    const naiveLocalRender = new Intl.DateTimeFormat(undefined, dateOptions).format(
      new Date("2026-08-20")
    );

    expect(formatCalendarDate("2026-08-20")).toBe(utcRender);

    if (naiveLocalRender !== utcRender) {
      expect(formatCalendarDate("2026-08-20")).not.toBe(naiveLocalRender);
    }
  });

  it("returns 'Not available' for empty, malformed, or impossible dates", () => {
    for (const value of [
      "",
      null,
      undefined,
      42,
      "not a date",
      "08/20/2026",
      "2026-8-20",
      "2026-02-30",
      "2026-13-01",
      "2026-00-10",
      "2026-08-20T00:00:00Z",
    ]) {
      expect(formatCalendarDate(value)).toBe("Not available");
    }
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
