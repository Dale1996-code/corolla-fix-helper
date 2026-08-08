import { Children } from "react";

// The one list/detail split used by Documents, Symptoms, Procedures, Notes,
// and Repair Checklists. It used to be five hand-copied `grid gap-6
// xl:grid-cols-*` divs that had already drifted apart (two bespoke track
// definitions, three plain `xl:grid-cols-2`), and all five shared the same
// bug, so it is fixed once here.
//
// Why the split starts at 1664px and not at Tailwind's `xl` (1280px):
//
// The shell in App.jsx is `max-w-[104rem]` (1664px) with a 288px sidebar and
// 64px of padding on <main>, so <main>'s content box tops out at 1312px no
// matter how wide the monitor is. Splitting that at `xl` gave the list
// 450-586px while the densest table (Documents) needs ~896px, so half the
// columns -- including the Favorite toggle, an interactive row action -- sat
// outside the scroller at *every* desktop width. Widening the browser made it
// worse, not better: going 1180px -> 1280px turned the split on and dropped
// the visible list from 826px to 486px.
//
// SPLIT_BREAKPOINT is therefore the width at which the shell reaches its own
// maximum, which is the first width where both panes genuinely fit
// (1312 - 24 gap = 1288, split 2.6fr/1fr = 930px list + 358px detail). Below
// it the layout stacks and the list gets the full content width, which is
// wider than the split ever gave it. Keep this value and App.jsx's max-w in
// step -- they describe the same pixel.
//
// Every class below is written out in full rather than composed from a
// `min-[1664px]` constant. Tailwind scans source files for complete class
// strings and never evaluates template literals, so a composed
// `${BREAKPOINT}:sticky` produces no CSS at all -- the first cut of this
// component silently rendered with no split and no sticky behaviour.
const SPLIT_BREAKPOINT = "min-[1664px]";

// The list is deliberately the dominant track and the detail is clamped by a
// rem minimum *and* a fractional maximum, so the detail can never squeeze the
// primary list: every pixel past the detail's readable measure goes to the
// table.
const SPLIT_COLUMNS = "min-[1664px]:grid-cols-[minmax(0,2.6fr)_minmax(20rem,1fr)]";

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
  "min-[1664px]:sticky min-[1664px]:top-6 min-[1664px]:self-start " +
  "min-[1664px]:max-h-[calc(100dvh-3rem)] min-[1664px]:overflow-y-auto";

// Takes exactly two children -- the list first, the detail panel second -- so
// a page keeps its existing JSX and only swaps the wrapping element.
export function ListDetailLayout({ children }) {
  const [list, detail] = Children.toArray(children);

  return (
    <div className={`grid gap-6 ${SPLIT_COLUMNS}`}>
      {/* min-w-0 on both panes: a grid item's automatic minimum size is its
          content's min-content width, which for these tables is ~900px. Without
          it the list track refuses to shrink and pushes the whole page into
          horizontal overflow instead of scrolling inside the table. The global
          `.editorial-app .flex > *` rule in index.css only covers flex. */}
      <div className="min-w-0">{list}</div>
      <div className={`min-w-0 ${STICKY_DETAIL}`}>{detail}</div>
    </div>
  );
}

// Exported so tests assert against the same strings the component renders,
// rather than re-typing the breakpoint and drifting from it.
export const listDetailLayoutClasses = {
  splitBreakpoint: SPLIT_BREAKPOINT,
  splitColumns: SPLIT_COLUMNS,
  stickyDetail: STICKY_DETAIL,
};
