import { expect, test } from "vitest";
import {
  buildDocumentsListQuery,
  countDocumentPages,
  DOCUMENTS_PER_PAGE,
} from "./documentsQuery";

const defaults = {
  sort: "newest",
  system: "all",
  documentType: "all",
  favorite: "all",
  bookmark: "all",
  tag: "all",
  page: 1,
};

function parse(view) {
  return Object.fromEntries(new URLSearchParams(buildDocumentsListQuery({ ...defaults, ...view })));
}

test("the default view is one bounded page with the sort spelled out", () => {
  expect(parse({})).toEqual({ limit: String(DOCUMENTS_PER_PAGE), offset: "0", sort: "newest" });
});

test("the page number becomes an offset in whole pages", () => {
  expect(parse({ page: 2 }).offset).toBe("25");
  expect(parse({ page: 58 }).offset).toBe(String(57 * 25));
});

test("an unusable page reads as the first page", () => {
  for (const page of [0, -3, 1.5, NaN, undefined, Number.MAX_SAFE_INTEGER + 2]) {
    expect(parse({ page }).offset, String(page)).toBe("0");
  }
});

test("filters at their default send nothing; chosen ones send the API's names", () => {
  expect(
    parse({
      system: "Brakes",
      documentType: "Wiring Diagram",
      favorite: "favorites_only",
      bookmark: "not_bookmarked",
      tag: "torque-specs",
      sort: "title_asc",
    })
  ).toEqual({
    limit: "25",
    offset: "0",
    sort: "title_asc",
    system: "Brakes",
    documentType: "Wiring Diagram",
    favorite: "true",
    bookmarked: "false",
    tag: "torque-specs",
  });

  expect(parse({ favorite: "not_favorites" }).favorite).toBe("false");
  expect(parse({ bookmark: "bookmarked_only" }).bookmarked).toBe("true");
});

test("values are encoded, not spliced", () => {
  const query = buildDocumentsListQuery({ ...defaults, system: "A&B=C #1" });

  expect(query).toContain("system=A%26B%3DC+%231");
  expect(new URLSearchParams(query).get("system")).toBe("A&B=C #1");
});

test("the same view is always the same string, so it can key a fetch", () => {
  expect(buildDocumentsListQuery({ ...defaults, system: "Brakes" })).toBe(
    buildDocumentsListQuery({ ...defaults, system: "Brakes" })
  );
});

test("page counts never drop below one", () => {
  expect(countDocumentPages(0)).toBe(1);
  expect(countDocumentPages(1)).toBe(1);
  expect(countDocumentPages(25)).toBe(1);
  expect(countDocumentPages(26)).toBe(2);
  expect(countDocumentPages(1443)).toBe(58);
  expect(countDocumentPages(NaN)).toBe(1);
  expect(countDocumentPages(undefined)).toBe(1);
});
