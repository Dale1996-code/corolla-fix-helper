import { describe, expect, test } from "vitest";
import { formatCount, formatLibraryTotal, formatResultRange } from "./resultRange";

const documents = { noun: "document", nounPlural: "documents" };

describe("formatCount", () => {
  test("separates thousands so a large library stays readable", () => {
    expect(formatCount(1443)).toBe("1,443");
    expect(formatCount(1000000)).toBe("1,000,000");
  });

  test("leaves small numbers alone", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(25)).toBe("25");
  });
});

describe("formatResultRange", () => {
  test("first page of a large library", () => {
    expect(
      formatResultRange({ from: 1, to: 25, total: 1443, ...documents })
    ).toBe("Showing 1–25 of 1,443 documents.");
  });

  test("middle page", () => {
    expect(
      formatResultRange({ from: 26, to: 50, total: 1443, ...documents })
    ).toBe("Showing 26–50 of 1,443 documents.");
  });

  test("final partial page stops at the total instead of the page size", () => {
    expect(formatResultRange({ from: 26, to: 33, total: 33, ...documents })).toBe(
      "Showing 26–33 of 33 documents."
    );
  });

  // The regression the audit called out: a caller that adds a whole page size to
  // the offset must never be able to print an end index past the total.
  test("clamps an end index that runs past the total", () => {
    expect(formatResultRange({ from: 26, to: 50, total: 33, ...documents })).toBe(
      "Showing 26–33 of 33 documents."
    );
  });

  test("exactly one result keeps singular grammar", () => {
    expect(formatResultRange({ from: 1, to: 1, total: 1, ...documents })).toBe(
      "Showing 1–1 of 1 document."
    );
  });

  test("a single result still reads as a range when the page starts late", () => {
    expect(formatResultRange({ from: 4, to: 4, total: 4, ...documents })).toBe(
      "Showing 4–4 of 4 documents."
    );
  });

  test("zero results get a sentence, never an impossible range", () => {
    const summary = formatResultRange({ from: 1, to: 0, total: 0, ...documents });

    expect(summary).toBe("No documents.");
    expect(summary).not.toContain("–");
    expect(summary).not.toContain("Showing");
  });

  test("zero results can carry a caller's own wording", () => {
    expect(
      formatResultRange({
        from: 1,
        to: 0,
        total: 0,
        ...documents,
        emptyText: "No documents match these filters.",
      })
    ).toBe("No documents match these filters.");
  });

  test("a suffix lands inside the sentence, before the period", () => {
    expect(
      formatResultRange({
        from: 1,
        to: 25,
        total: 1443,
        ...documents,
        suffix: "in your library",
      })
    ).toBe("Showing 1–25 of 1,443 documents in your library.");
  });

  // Nonsense in must not produce a nonsense range out: these are the shapes a
  // page can pass mid-load, before its totals have settled.
  test("nonsensical bounds are repaired rather than rendered", () => {
    expect(formatResultRange({ from: 0, to: 0, total: 5, ...documents })).toBe(
      "Showing 1–1 of 5 documents."
    );
    expect(formatResultRange({ from: 9, to: 3, total: 5, ...documents })).toBe(
      "Showing 3–3 of 5 documents."
    );
    expect(
      formatResultRange({ from: undefined, to: undefined, total: undefined, ...documents })
    ).toBe("No documents.");
  });

  test("no rendered range ever ends above its own total", () => {
    for (const [from, to, total] of [
      [1, 25, 1443],
      [26, 50, 33],
      [1, 99, 1],
      [500, 1000, 750],
    ]) {
      const summary = formatResultRange({ from, to, total, ...documents });
      const match = summary.match(/Showing ([\d,]+)–([\d,]+) of ([\d,]+)/);
      const asNumber = (value) => Number(value.replace(/,/g, ""));

      expect(match).not.toBeNull();
      expect(asNumber(match[2])).toBeLessThanOrEqual(asNumber(match[3]));
      expect(asNumber(match[1])).toBeLessThanOrEqual(asNumber(match[2]));
      expect(asNumber(match[1])).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("formatLibraryTotal", () => {
  test("states a total for a list that is always shown whole", () => {
    expect(
      formatLibraryTotal({ total: 12, noun: "checklist", nounPlural: "checklists" })
    ).toBe("12 checklists in your library.");
  });

  test("keeps singular grammar and thousands separators", () => {
    expect(
      formatLibraryTotal({ total: 1, noun: "checklist", nounPlural: "checklists" })
    ).toBe("1 checklist in your library.");
    expect(
      formatLibraryTotal({ total: 2500, noun: "document", nounPlural: "documents" })
    ).toBe("2,500 documents in your library.");
  });

  test("an empty library reads as a zero-state, not as '0 in your library'", () => {
    expect(
      formatLibraryTotal({ total: 0, noun: "checklist", nounPlural: "checklists" })
    ).toBe("No checklists yet.");
  });
});
