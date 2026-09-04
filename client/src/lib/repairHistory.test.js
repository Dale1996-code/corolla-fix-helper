import { describe, expect, test } from "vitest";
import {
  DEFAULT_REPAIR_OUTCOME,
  formatOdometerMiles,
  parseOdometerInput,
  REPAIR_OUTCOME_OPTIONS,
  repairOutcomeLabel,
} from "./repairHistory";

describe("REPAIR_OUTCOME_OPTIONS", () => {
  // The server's CHECK constraint vocabulary, in the order the form offers it.
  // A value here that the column would reject is a form that can only fail.
  test("offers exactly the outcomes the API accepts", () => {
    expect(REPAIR_OUTCOME_OPTIONS.map((option) => option.value)).toEqual([
      "fixed",
      "partial",
      "not_fixed",
      "unknown",
    ]);
  });

  test("labels every outcome in words, never as its stored token", () => {
    for (const option of REPAIR_OUTCOME_OPTIONS) {
      expect(option.label).not.toBe(option.value);
      expect(option.label).not.toMatch(/_/);
    }

    expect(REPAIR_OUTCOME_OPTIONS.map((option) => option.label)).toEqual([
      "Fixed",
      "Partially fixed",
      "Not fixed",
      "Unknown",
    ]);
  });

  test("defaults to the outcome the server defaults to", () => {
    expect(DEFAULT_REPAIR_OUTCOME).toBe("unknown");
  });
});

describe("repairOutcomeLabel", () => {
  test("names each stored outcome", () => {
    expect(repairOutcomeLabel("fixed")).toBe("Fixed");
    expect(repairOutcomeLabel("partial")).toBe("Partially fixed");
    expect(repairOutcomeLabel("not_fixed")).toBe("Not fixed");
    expect(repairOutcomeLabel("unknown")).toBe("Unknown");
  });

  // A raw token on screen would tell the owner nothing, so an unrecognised
  // value reads as Unknown rather than being echoed through.
  test("never echoes an unrecognised value", () => {
    for (const value of ["", null, undefined, "NOT_FIXED", "exploded", 7, {}]) {
      expect(repairOutcomeLabel(value)).toBe("Unknown");
    }
  });
});

describe("formatOdometerMiles", () => {
  test("separates thousands and names the unit", () => {
    expect(formatOdometerMiles(183456)).toBe("183,456 mi");
    expect(formatOdometerMiles(1000000)).toBe("1,000,000 mi");
  });

  // Zero is a reading and null is the absence of one; the two must not render
  // the same way.
  test("keeps a reading of zero distinct from no reading at all", () => {
    expect(formatOdometerMiles(0)).toBe("0 mi");
    expect(formatOdometerMiles(null)).toBe("Not recorded");
  });

  test("says so plainly when the reading was never written down", () => {
    for (const value of [null, undefined, "", "183456", 1.5, -1, NaN]) {
      expect(formatOdometerMiles(value)).toBe("Not recorded");
    }
  });

  test("lets a caller choose the wording for a missing reading", () => {
    expect(formatOdometerMiles(null, { missingText: "—" })).toBe("—");
  });
});

describe("parseOdometerInput", () => {
  // The whole point of the helper: blank means "I did not write it down", which
  // is null. Coercing it would make it a legitimate-looking reading of zero.
  test("reads a blank box as no reading, never as zero", () => {
    for (const value of ["", "   ", null, undefined]) {
      expect(parseOdometerInput(value)).toEqual({ ok: true, odometerMiles: null });
    }
  });

  test("returns a real JSON number, not the typed string", () => {
    const parsed = parseOdometerInput("183456");

    expect(parsed).toEqual({ ok: true, odometerMiles: 183456 });
    expect(typeof parsed.odometerMiles).toBe("number");
  });

  test("keeps a genuine zero reading", () => {
    expect(parseOdometerInput("0")).toEqual({ ok: true, odometerMiles: 0 });
  });

  test("trims surrounding whitespace", () => {
    expect(parseOdometerInput("  4200 ")).toEqual({ ok: true, odometerMiles: 4200 });
  });

  // Refused here rather than sent: the API rejects anything that is not a whole
  // JSON number, and a 400 is a worse answer than the box the owner can fix.
  test("refuses anything that is not a whole number of miles", () => {
    for (const value of ["abc", "12.5", "-4", "1e3", "12 000", "0x0c", "183,456", " "]) {
      const parsed = parseOdometerInput(value);

      if (value.trim() === "") {
        expect(parsed.ok).toBe(true);
        continue;
      }

      expect(parsed.ok).toBe(false);
      expect(parsed.error).toMatch(/whole number of miles/i);
    }
  });

  test("refuses a reading too large to be a safe integer", () => {
    expect(parseOdometerInput("9".repeat(20)).ok).toBe(false);
  });
});
