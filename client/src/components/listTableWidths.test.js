import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { computeSplitPaneWidths, listDetailLayoutMetrics } from "./ListDetailLayout";
import { documentsListTable } from "./documents/DocumentsList";
import { symptomsListTable } from "./symptoms/SymptomsList";
import { proceduresListTable } from "./procedures/ProceduresList";
import { notesListTable } from "../pages/NotesPage";
import { checklistListTable } from "../pages/RepairChecklistsPage";
import { repairHistoryListTable } from "../pages/RepairHistoryPage";

// Two H6 invariants live here.
//
// 1. Internal consistency of a single table. Every list declares its real width
//    twice -- once as the `minmax()` minimums of its grid tracks, and once as
//    the `min-w-[...]` on the scroll wrapper -- and the two had drifted apart.
//    The wrapper claimed 820px on Documents while the tracks summed to 1016px,
//    so the wrapper was inert and nobody noticed the table had grown 200px past
//    what any pane could show. The wrapper cannot simply be deleted: it is what
//    makes a row's border and selected-row background paint across the full
//    scroll width instead of stopping at the visible edge. So it has to stay,
//    and it has to stay >= the tracks.
//
// 2. Fit against the layout that has to display it. The widest table must still
//    fit the list pane that the shell width, the split breakpoint, and the
//    split's track definition actually leave for it. That number is computed
//    from `listDetailLayoutMetrics` rather than written down here, because a
//    hand-copied "930" would keep passing after the shell or the split ratio
//    changed underneath it -- which is precisely how H6 shipped.
//
// Each table's two class strings come from the list's own exported definition,
// so this file names the element it is measuring instead of scanning a source
// file for its first arbitrary Tailwind class and hoping that class belongs to
// the list. That mattered most for Notes and Repair Checklists, whose lists are
// page-local components inside 1000+ line page files.

const GAP_PX = 12; // gap-3
const ROW_PADDING_PX = 32; // px-4 on both edges
const ROOT_FONT_PX = listDetailLayoutMetrics.rootFontPx;

const LISTS = [
  { table: documentsListTable, file: "./documents/DocumentsList.jsx", symbol: "documentsListTable" },
  { table: symptomsListTable, file: "./symptoms/SymptomsList.jsx", symbol: "symptomsListTable" },
  {
    table: proceduresListTable,
    file: "./procedures/ProceduresList.jsx",
    symbol: "proceduresListTable",
  },
  { table: notesListTable, file: "../pages/NotesPage.jsx", symbol: "notesListTable" },
  {
    table: checklistListTable,
    file: "../pages/RepairChecklistsPage.jsx",
    symbol: "checklistListTable",
  },
  {
    table: repairHistoryListTable,
    file: "../pages/RepairHistoryPage.jsx",
    symbol: "repairHistoryListTable",
  },
].map((entry) => ({ ...entry, name: entry.table.name }));

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

function parseList({ gridClass, minWidthClass }) {
  const grid = /grid-cols-\[([^\]]+)\]/.exec(gridClass);
  if (!grid) throw new Error(`no grid-cols track definition in: ${gridClass}`);

  // Each track is minmax(<min>,<max>); only the minimum sets the table's
  // intrinsic width, which is the number that matters here.
  const minimums = [...grid[1].matchAll(/minmax\(([^,]+),[^)]+\)/g)].map((m) => toPx(m[1].trim()));

  const wrapper = /^min-w-\[([\d.]+(?:rem|px))\]$/.exec(minWidthClass);
  if (!wrapper) throw new Error(`unrecognised wrapper width: ${minWidthClass}`);

  return { minimums, wrapperPx: toPx(wrapper[1]) };
}

// The pane the split actually hands the list once the shell is at its maximum,
// which is true from the split breakpoint upwards.
const { listPx: primaryPanePx } = computeSplitPaneWidths();

// The widest table any list pane has to show. Derived, so adding a column to
// Documents raises the bar for the layout instead of quietly clipping.
const widestTablePx = Math.max(...LISTS.map(({ table }) => parseList(table).wrapperPx));

describe.each(LISTS)("$name", ({ table, file, symbol }) => {
  const source = readSource(file);

  test("the scroll wrapper is at least as wide as the grid tracks it wraps", () => {
    const { minimums, wrapperPx } = parseList(table);
    const tracksPx =
      minimums.reduce((sum, px) => sum + px, 0) +
      (minimums.length - 1) * GAP_PX +
      ROW_PADDING_PX;

    expect(wrapperPx).toBeGreaterThanOrEqual(tracksPx);
    // ...and not wildly past it, which would reintroduce dead horizontal space.
    expect(wrapperPx).toBeLessThan(tracksPx + 2 * ROOT_FONT_PX);
  });

  test("the table fits the list pane the split gives it", () => {
    const { wrapperPx } = parseList(table);

    // A table wider than its pane puts columns back outside the scroller at
    // desktop width, which is exactly H6.
    expect(wrapperPx).toBeLessThanOrEqual(primaryPanePx);
  });

  test("the scroller is scoped to the table, not the page", () => {
    expect(source).toContain("overflow-x-auto");
  });

  test("the list renders the exported width definition rather than its own copy", () => {
    // Guards the indirection every assertion above depends on: if a list goes
    // back to inlining its classes, the definition imported here stops
    // describing what renders and the checks would measure a dead constant.
    expect(source).toContain(`${symbol}.gridClass`);
    expect(source).toContain(`${symbol}.minWidthClass`);
  });

  test("an unrelated arbitrary width earlier in the file cannot be measured by mistake", () => {
    // This file used to regex the source and take the *first* arbitrary
    // grid/min-w class it found. That happened to hit the list, but any
    // unrelated `min-w-[...]` added above it -- easy to do in the two page
    // files, which are 1000+ lines and hold much more than their list -- would
    // have silently moved the measurement to the wrong element while the test
    // kept passing. Naming the definition removes source order from the answer.
    const decoyed = `const decoy = "min-w-[99rem] grid-cols-[minmax(99rem,1fr)]";\n${source}`;
    const firstArbitraryWidth = /min-w-\[([\d.]+(?:rem|px))\]/.exec(decoyed)[1];

    // What the old approach would now be measuring...
    expect(toPx(firstArbitraryWidth)).toBe(99 * ROOT_FONT_PX);
    // ...and what this file measures instead.
    expect(parseList(table).wrapperPx).not.toBe(99 * ROOT_FONT_PX);
  });
});

describe("the split fits the widest list table", () => {
  test("the primary pane is at least as wide as the widest table", () => {
    expect(primaryPanePx).toBeGreaterThanOrEqual(widestTablePx);
  });

  test("the arithmetic matches the classes the layout renders", () => {
    // Everything the computation reads is rem, so the invariant holds at any
    // root font size -- which is why the split breakpoint is `min-[104rem]`
    // and not `min-[1664px]`.
    const { mainContentPx, listPx, detailPx } = computeSplitPaneWidths();

    expect(mainContentPx).toBe(82 * ROOT_FONT_PX); // 104rem shell - 18rem sidebar - 4rem padding
    expect(listPx + detailPx + listDetailLayoutMetrics.columnGapRem * ROOT_FONT_PX).toBeCloseTo(
      mainContentPx,
      5
    );
    expect(detailPx).toBeGreaterThanOrEqual(listDetailLayoutMetrics.detailMinWidthRem * ROOT_FONT_PX);
  });

  test("the split only turns on once the shell has reached its maximum width", () => {
    // The pane arithmetic assumes the shell is at max-width. If the split fired
    // earlier, every number above would be optimistic.
    expect(listDetailLayoutMetrics.splitBreakpointRem).toBeGreaterThanOrEqual(
      listDetailLayoutMetrics.shellMaxWidthRem
    );
  });

  // The two regressions the previous version of this file could not see. Both
  // are expressed as overrides of the real metrics, so they fail for the same
  // reason the app would: the computed pane stops fitting the real tables.
  test("a shell narrowed back to 88rem would clip the widest table", () => {
    const { listPx } = computeSplitPaneWidths({ shellMaxWidthRem: 88 });

    expect(listPx).toBeLessThan(widestTablePx);
  });

  test("a split ratio that favours the detail pane would clip the widest table", () => {
    const { listPx } = computeSplitPaneWidths({ listFr: 1, detailFr: 1.4 });

    expect(listPx).toBeLessThan(widestTablePx);
  });

  test("a detail minimum wide enough to squeeze the list would clip the widest table", () => {
    const { listPx } = computeSplitPaneWidths({ detailMinWidthRem: 40 });

    expect(listPx).toBeLessThan(widestTablePx);
  });
});
