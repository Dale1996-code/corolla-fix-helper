import { useEffect, useRef } from "react";

// The one list/detail split used by Documents, Symptoms, Procedures, Notes,
// and Repair Checklists. It used to be five hand-copied `grid gap-6
// xl:grid-cols-*` divs that had already drifted apart (two bespoke track
// definitions, three plain `xl:grid-cols-2`), and all five shared the same
// bug, so it is fixed once here.
//
// Why the split starts at 104rem and not at Tailwind's `xl` (80rem):
//
// The shell in App.jsx is `max-w-[104rem]` with an 18rem sidebar and 4rem of
// padding on <main>, so <main>'s content box tops out at 82rem no matter how
// wide the monitor is. Splitting that at `xl` gave the list 450-586px while
// the densest table (Documents) needs 56rem, so half the columns -- including
// the Favorite toggle, an interactive row action -- sat outside the scroller
// at *every* desktop width. Widening the browser made it worse, not better:
// going 1180px -> 1280px turned the split on and dropped the visible list from
// 826px to 486px.
//
// SPLIT_BREAKPOINT is therefore the width at which the shell reaches its own
// maximum, which is the first width where both panes genuinely fit. The whole
// chain -- shell, sidebar, padding, gap, detail minimum, and every table's
// `min-w-[...]` -- is expressed in rem, so the breakpoint is too: `min-[104rem]`
// and `min-[1664px]` only mean the same thing at a 16px root font size, and a
// browser or user font-size preference would otherwise fire the split before
// there is physically enough width for the list pane. Below the breakpoint the
// layout stacks and the list gets the full content width, which is wider than
// the split ever gave it. `listDetailLayoutMetrics` below is the numeric form
// of that chain, and `computeSplitPaneWidths` is the arithmetic the tests use
// to prove the list pane still fits the widest table.
//
// Every class below is written out in full rather than composed from a
// `min-[104rem]` constant. Tailwind scans source files for complete class
// strings and never evaluates template literals, so a composed
// `${BREAKPOINT}:sticky` produces no CSS at all -- the first cut of this
// component silently rendered with no split and no sticky behaviour.
const SPLIT_BREAKPOINT = "min-[104rem]";

// The list is deliberately the dominant track and the detail is clamped by a
// rem minimum *and* a fractional maximum, so the detail can never squeeze the
// primary list: every pixel past the detail's readable measure goes to the
// table.
const SPLIT_COLUMNS = "min-[104rem]:grid-cols-[minmax(0,2.6fr)_minmax(20rem,1fr)]";

const SPLIT_GAP = "gap-6";

// Sticky only once the layout is actually side by side. On desktop nothing is
// pinned to the top of the page -- MobileNav is `lg:hidden` and the sidebar is
// a sticky *left* column -- so `top-6` is a breathing gutter rather than
// header clearance, and the panel cannot overlap the header.
//
// The max-height is not optional: the Documents panel is ~2263px tall against
// a ~900px viewport, and a plain `sticky top-6` pins its top and leaves the
// bottom permanently unreachable. Capping it to the viewport and letting it
// scroll keeps the whole record accessible. Every detail panel contains
// buttons, so the scroll region is reachable by keyboard (tabbing scrolls it)
// and is not a trap.
const STICKY_DETAIL =
  "min-[104rem]:sticky min-[104rem]:top-6 min-[104rem]:self-start " +
  "min-[104rem]:max-h-[calc(100dvh-3rem)] min-[104rem]:overflow-y-auto";

// The shell width lives here rather than in App.jsx because it is one half of
// this component's contract: the split only fits because <main> is guaranteed
// this much room. App.jsx imports it, so the two cannot drift.
const APP_SHELL_MAX_WIDTH = "max-w-[104rem]";

// The numbers behind the classes above, so a test can derive the pane widths
// instead of restating them as literals. Everything is rem, which is what makes
// the layout independent of the root font size: the ratio between the list pane
// and a table's `min-w-[56rem]` is the same at any font size, and `rootFontPx`
// is only a conversion reference for the tables still written in px.
export const listDetailLayoutMetrics = {
  rootFontPx: 16,
  // App.jsx: max-w-[104rem] on the flex shell.
  shellMaxWidthRem: 104,
  // Sidebar.jsx: w-72, visible at every width at or above the split.
  sidebarWidthRem: 18,
  // <main> in App.jsx: lg:px-8, both edges.
  mainPaddingRem: 4,
  // Where the split turns on; must be >= shellMaxWidthRem, otherwise the shell
  // is still narrower than its maximum when the split fires and the pane
  // arithmetic below is optimistic.
  splitBreakpointRem: 104,
  // SPLIT_GAP: gap-6.
  columnGapRem: 1.5,
  // SPLIT_COLUMNS: minmax(0,2.6fr) minmax(20rem,1fr).
  listFr: 2.6,
  detailFr: 1,
  detailMinWidthRem: 20,
};

// The width each pane actually gets once the shell is at its maximum, which is
// true from the split breakpoint upwards. Overrides let a test ask "what would
// a narrower shell / a greedier detail track do?" without editing the app.
export function computeSplitPaneWidths(overrides = {}) {
  const metrics = { ...listDetailLayoutMetrics, ...overrides };
  const toPx = (rem) => rem * metrics.rootFontPx;

  const mainContentPx =
    toPx(metrics.shellMaxWidthRem) - toPx(metrics.sidebarWidthRem) - toPx(metrics.mainPaddingRem);
  const trackSpacePx = mainContentPx - toPx(metrics.columnGapRem);

  // Grid resolves the fr shares first; a share below the track's minmax()
  // minimum is raised to that minimum and the remainder goes to the other
  // track, which is exactly what the detail's `minmax(20rem,1fr)` does.
  const detailSharePx = (trackSpacePx * metrics.detailFr) / (metrics.listFr + metrics.detailFr);
  const detailPx = Math.max(detailSharePx, toPx(metrics.detailMinWidthRem));
  const listPx = Math.max(trackSpacePx - detailPx, 0);

  return { mainContentPx, listPx, detailPx };
}

// Named props rather than positional children. `Children.toArray` drops null
// and false, so `{condition && <Detail />}` as a second child used to shift the
// detail element into the list slot silently -- the detail would render
// unstyled in the list pane and lose its sticky behaviour. With named props a
// falsy value just leaves that pane empty, and a missing one throws.
//
// `selectedId` exists only so the detail pane's own scroll container can be
// returned to the top when a different record is selected; see the effect.
export function ListDetailLayout({ list, detail, selectedId = null }) {
  const detailRef = useRef(null);

  // The detail pane is its own scroll container (STICKY_DETAIL), and the same
  // DOM node survives a selection change, so record B would otherwise open at
  // record A's scrollTop -- often with its own heading scrolled out of view.
  // Resetting the node directly, keyed on the selected record's identity, is
  // deliberate: a React `key` here would remount the whole detail subtree and
  // throw away in-progress edit-form state on every selection.
  useEffect(() => {
    const pane = detailRef.current;
    if (pane) pane.scrollTop = 0;
  }, [selectedId]);

  if (list === undefined || list === null || detail === undefined || detail === null) {
    throw new Error(
      "ListDetailLayout requires both a `list` and a `detail` prop. " +
        `Received list=${describeSlot(list)}, detail=${describeSlot(detail)}.`
    );
  }

  return (
    <div className={`grid ${SPLIT_GAP} ${SPLIT_COLUMNS}`}>
      {/* min-w-0 on both panes: a grid item's automatic minimum size is its
          content's min-content width, which for these tables is ~900px. Without
          it the list track refuses to shrink and pushes the whole page into
          horizontal overflow instead of scrolling inside the table. The global
          `.editorial-app .flex > *` rule in index.css only covers flex. */}
      <div className="min-w-0">{list}</div>
      <div ref={detailRef} className={`min-w-0 ${STICKY_DETAIL}`}>
        {detail}
      </div>
    </div>
  );
}

function describeSlot(value) {
  return value === undefined ? "undefined" : String(value);
}

// Exported so tests assert against the same strings the component renders,
// rather than re-typing the breakpoint and drifting from it. The *sizes* those
// classes imply are asserted from `listDetailLayoutMetrics` instead, so a test
// cannot pass by comparing a class to itself.
export const listDetailLayoutClasses = {
  splitBreakpoint: SPLIT_BREAKPOINT,
  splitColumns: SPLIT_COLUMNS,
  splitGap: SPLIT_GAP,
  stickyDetail: STICKY_DETAIL,
  appShellMaxWidth: APP_SHELL_MAX_WIDTH,
};
