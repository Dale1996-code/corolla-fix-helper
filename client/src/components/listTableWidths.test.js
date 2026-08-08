import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// The H6 defect these guard against: every list table declares its real width
// twice -- once as the `minmax()` minimums of its grid tracks, and once as the
// `min-w-[...]` on the scroll wrapper -- and the two had drifted apart. The
// wrapper claimed 820px on Documents while the tracks summed to 1016px, so the
// wrapper was inert and nobody noticed the table had grown 200px past what any
// pane could show.
//
// The wrapper cannot simply be deleted: it is what makes a row's border and
// selected-row background paint across the full scroll width instead of
// stopping at the visible edge. So it has to stay, and it has to stay >= the
// tracks. That is what this file checks, at the source level, so it covers the
// two lists that are still page-local components as well as the three exported
// ones.

const GAP_PX = 12; // gap-3
const ROW_PADDING_PX = 32; // px-4 on both edges
const ROOT_FONT_PX = 16;

const LISTS = [
  { name: "DocumentsList", file: "./documents/DocumentsList.jsx" },
  { name: "SymptomsList", file: "./symptoms/SymptomsList.jsx" },
  { name: "ProceduresList", file: "./procedures/ProceduresList.jsx" },
  { name: "NotesList", file: "../pages/NotesPage.jsx" },
  { name: "ChecklistList", file: "../pages/RepairChecklistsPage.jsx" },
];

function readSource(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

function toPx(value) {
  const rem = /^([\d.]+)rem$/.exec(value);
  if (rem) return Number(rem[1]) * ROOT_FONT_PX;
  const px = /^([\d.]+)px$/.exec(value);
  if (px) return Number(px[1]);
  throw new Error(`Unsupported length: ${value}`);
}

function parseList(source) {
  const grid = /grid grid-cols-\[([^\]]+)\] gap-3/.exec(source);
  if (!grid) throw new Error("no listGridClass found");

  // Each track is minmax(<min>,<max>); only the minimum sets the table's
  // intrinsic width, which is the number that matters here.
  const minimums = [...grid[1].matchAll(/minmax\(([^,]+),[^)]+\)/g)].map((m) => toPx(m[1].trim()));

  const wrapper = /min-w-\[([\d.]+(?:rem|px))\]/.exec(source);
  if (!wrapper) throw new Error("no min-w wrapper found");

  return { minimums, wrapperPx: toPx(wrapper[1]) };
}

describe.each(LISTS)("$name", ({ file }) => {
  const source = readSource(file);

  test("the scroll wrapper is at least as wide as the grid tracks it wraps", () => {
    const { minimums, wrapperPx } = parseList(source);
    const tracksPx =
      minimums.reduce((sum, px) => sum + px, 0) +
      (minimums.length - 1) * GAP_PX +
      ROW_PADDING_PX;

    expect(wrapperPx).toBeGreaterThanOrEqual(tracksPx);
    // ...and not wildly past it, which would reintroduce dead horizontal space.
    expect(wrapperPx).toBeLessThan(tracksPx + 2 * ROOT_FONT_PX);
  });

  test("the table still fits the list pane the split gives it", () => {
    const { wrapperPx } = parseList(source);

    // At the 1664px split breakpoint the shell is at its 104rem maximum, so
    // <main>'s content box is 1312px; minus the 24px gap and split 2.6fr/1fr,
    // the list pane is ~930px. A table wider than that would put columns back
    // outside the scroller at desktop width, which is exactly H6.
    expect(wrapperPx).toBeLessThanOrEqual(930);
  });

  test("the scroller is scoped to the table, not the page", () => {
    expect(source).toContain("overflow-x-auto");
  });
});
