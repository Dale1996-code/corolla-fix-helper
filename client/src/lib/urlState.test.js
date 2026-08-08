import { describe, expect, test } from "vitest";
import {
  applyParamUpdates,
  clearFilterUpdates,
  filterValueUpdates,
  pageParamValue,
  readEnumParam,
  readFilterValues,
  readIdParam,
  readPageParam,
  readTextParam,
  resolveSelectedRecord,
} from "./urlState";

function params(query) {
  return new URLSearchParams(query);
}

describe("readEnumParam", () => {
  test("keeps a value from the allowed set", () => {
    expect(readEnumParam(params("sort=title_asc"), "sort", ["newest", "title_asc"], "newest")).toBe(
      "title_asc"
    );
  });

  test("falls back for a missing, empty, or unknown value", () => {
    const allowed = ["newest", "oldest"];

    expect(readEnumParam(params(""), "sort", allowed, "newest")).toBe("newest");
    expect(readEnumParam(params("sort="), "sort", allowed, "newest")).toBe("newest");
    expect(readEnumParam(params("sort=sideways"), "sort", allowed, "newest")).toBe("newest");
  });
});

describe("readTextParam", () => {
  test("returns the value, or the default when absent or empty", () => {
    expect(readTextParam(params("q=brake"), "q")).toBe("brake");
    expect(readTextParam(params(""), "q")).toBe("");
    expect(readTextParam(params("q="), "q")).toBe("");
    expect(readTextParam(params(""), "system", "all")).toBe("all");
  });
});

describe("readIdParam", () => {
  test("accepts a positive integer", () => {
    expect(readIdParam(params("documentId=42"), "documentId")).toBe(42);
  });

  // Anything else must read as "no selection" rather than reaching a lookup:
  // these all come back from Number() as something that looks usable.
  test.each([
    ["documentId=abc", "not a number"],
    ["documentId=0", "zero"],
    ["documentId=-4", "negative"],
    ["documentId=2.5", "fractional"],
    ["documentId=1e3", "exponent notation"],
    ["documentId=%2012%20", "padded with spaces"],
    ["documentId=", "empty"],
    ["", "absent"],
  ])("rejects %s (%s)", (query) => {
    expect(readIdParam(params(query), "documentId")).toBe(null);
  });
});

describe("readPageParam", () => {
  test("reads a page number above the first page", () => {
    expect(readPageParam(params("page=7"))).toBe(7);
    expect(readPageParam(params("documents.page=3"), "documents.page")).toBe(3);
  });

  test.each(["", "page=", "page=abc", "page=0", "page=-2", "page=1.5", "page=2e2"])(
    "falls back to page 1 for %s",
    (query) => {
      expect(readPageParam(params(query))).toBe(1);
    }
  );
});

describe("pageParamValue", () => {
  test("omits the first page and keeps the rest", () => {
    expect(pageParamValue(1)).toBe(null);
    expect(pageParamValue(4)).toBe("4");
  });
});

describe("applyParamUpdates", () => {
  test("sets values and removes the ones back at their default", () => {
    const next = applyParamUpdates(params("system=Brakes&page=3"), {
      system: null,
      sort: "title_asc",
    });

    expect(next.get("system")).toBe(null);
    expect(next.get("sort")).toBe("title_asc");
    expect(next.get("page")).toBe("3");
  });

  test.each([null, undefined, ""])("removes a key set to %p", (value) => {
    expect(applyParamUpdates(params("tag=brakes"), { tag: value }).has("tag")).toBe(false);
  });

  test("carries through parameters it was not asked about", () => {
    const next = applyParamUpdates(params("documentId=9&somethingElse=keep"), { page: "2" });

    expect(next.get("documentId")).toBe("9");
    expect(next.get("somethingElse")).toBe("keep");
  });

  test("does not mutate the params it was given", () => {
    const current = params("page=2");
    applyParamUpdates(current, { page: null, sort: "oldest" });

    expect(current.toString()).toBe("page=2");
  });
});

describe("readFilterValues / filterValueUpdates", () => {
  const spec = {
    q: { default: "" },
    status: { default: "all", options: ["all", "open", "resolved"] },
    system: { default: "all" },
  };

  test("reads a whole group, defaulting what the URL leaves out", () => {
    expect(readFilterValues(params("q=idle&status=resolved"), spec)).toEqual({
      q: "idle",
      status: "resolved",
      system: "all",
    });
  });

  test("normalizes an unknown option back to its default", () => {
    expect(readFilterValues(params("status=banana"), spec).status).toBe("all");
  });

  test("writes back only the values that are not at their default", () => {
    expect(filterValueUpdates({ q: "", status: "open", system: "all" }, spec)).toEqual({
      q: null,
      status: "open",
      system: null,
    });
  });

  test("clearing names every parameter the group owns", () => {
    expect(clearFilterUpdates(spec)).toEqual({ q: null, status: null, system: null });
  });
});

describe("resolveSelectedRecord", () => {
  const first = { id: 1 };
  const second = { id: 2 };
  const third = { id: 3 };
  const records = [first, second, third];

  test("prefers the record the URL names", () => {
    expect(resolveSelectedRecord(3, records, records)).toBe(third);
  });

  test("falls back to the first loaded record when the URL names nothing", () => {
    expect(resolveSelectedRecord(null, records, [third, second, first])).toBe(first);
  });

  test("falls back to the first visible record when the URL's record is filtered out", () => {
    expect(resolveSelectedRecord(1, records, [second, third])).toBe(second);
  });

  test("returns null when nothing is visible", () => {
    expect(resolveSelectedRecord(2, records, [])).toBe(null);
    expect(resolveSelectedRecord(null, [], [])).toBe(null);
  });
});
