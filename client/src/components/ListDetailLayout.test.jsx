import { useEffect, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import {
  ListDetailLayout,
  computeSplitPaneWidths,
  listDetailLayoutClasses,
  listDetailLayoutMetrics,
} from "./ListDetailLayout";

// jsdom has no layout engine, so these assert the layout *semantics* -- which
// primitive is used, which breakpoint gates the split, which pane is sticky,
// what happens to the detail pane's scroll position -- rather than pixel
// results. The pixel arithmetic is asserted from `listDetailLayoutMetrics` in
// listTableWidths.test.js, and real viewport behaviour is covered by the
// Playwright viewport sweep described in the H6 notes.

function renderLayout(props = {}) {
  const { container, rerender } = render(
    <ListDetailLayout
      list={<section data-testid="list-pane">List</section>}
      detail={<section data-testid="detail-pane">Detail</section>}
      {...props}
    />
  );
  const grid = container.querySelector("div.grid");
  return {
    grid,
    listWrapper: grid.children[0],
    detailWrapper: grid.children[1],
    rerender,
    container,
  };
}

test("ListDetailLayout renders the list first and the detail second", () => {
  const { listWrapper, detailWrapper } = renderLayout();

  expect(listWrapper).toContainElement(screen.getByTestId("list-pane"));
  expect(detailWrapper).toContainElement(screen.getByTestId("detail-pane"));
});

test("ListDetailLayout stacks by default and only splits at the wide breakpoint", () => {
  const { grid } = renderLayout();

  // No unprefixed grid-cols: the stacked single column is the mobile-first
  // default, so narrow screens keep normal document flow with no media query.
  expect(grid.className).toContain("grid");
  expect(grid.className).toContain(listDetailLayoutClasses.splitColumns);
  expect(grid.className).not.toMatch(/(?:^|\s)grid-cols-/);
});

test("the split breakpoint is expressed in rem, not px", () => {
  const { grid } = renderLayout();

  // xl (80rem) is what caused H6: it split a content box that was never wider
  // than 66rem, leaving the list ~30rem against a ~56rem table.
  expect(grid.className).not.toContain("xl:grid-cols");
  expect(listDetailLayoutClasses.splitBreakpoint).toBe("min-[104rem]");

  // Every class and every metric in the chain is rem, so the split fires at the
  // width where the panes genuinely fit at *any* root font size. A px
  // breakpoint only agrees with the rem-based tracks at a 16px root.
  for (const className of [
    listDetailLayoutClasses.splitColumns,
    listDetailLayoutClasses.stickyDetail,
    listDetailLayoutClasses.appShellMaxWidth,
  ]) {
    expect(className).not.toMatch(/\[\d+(?:\.\d+)?px/);
  }
  expect(listDetailLayoutClasses.splitBreakpoint).toBe(
    `min-[${listDetailLayoutMetrics.splitBreakpointRem}rem]`
  );
  expect(listDetailLayoutClasses.appShellMaxWidth).toBe(
    `max-w-[${listDetailLayoutMetrics.shellMaxWidthRem}rem]`
  );
});

test("the split's numeric metrics describe the classes it renders", () => {
  const { grid } = renderLayout();

  // The metrics are what the pane-fit invariant is computed from, so they have
  // to keep describing the track definition that actually ships.
  const { listFr, detailFr, detailMinWidthRem } = listDetailLayoutMetrics;
  expect(grid.className).toContain(
    `grid-cols-[minmax(0,${listFr}fr)_minmax(${detailMinWidthRem}rem,${detailFr}fr)]`
  );
  expect(grid.className).toContain(listDetailLayoutClasses.splitGap);
  // Tailwind's spacing unit is 0.25rem, so gap-6 is the 1.5rem the arithmetic
  // subtracts from the content box before dividing it between the two tracks.
  const TAILWIND_SPACING_REM = 0.25;
  expect(listDetailLayoutClasses.splitGap).toBe(
    `gap-${listDetailLayoutMetrics.columnGapRem / TAILWIND_SPACING_REM}`
  );
});

test("the split leaves the list the dominant pane", () => {
  const { listPx, detailPx } = computeSplitPaneWidths();

  expect(listPx).toBeGreaterThan(detailPx);
});

test("only the detail pane is sticky, and only at the split breakpoint", () => {
  const { listWrapper, detailWrapper } = renderLayout();

  for (const className of listDetailLayoutClasses.stickyDetail.split(/\s+/)) {
    expect(className.startsWith(`${listDetailLayoutClasses.splitBreakpoint}:`)).toBe(true);
    expect(detailWrapper.className).toContain(className);
  }

  expect(listWrapper.className).not.toContain("sticky");
});

test("the sticky detail pane is capped to the viewport so a tall record stays reachable", () => {
  const { detailWrapper } = renderLayout();

  // Without the cap, `sticky` pins the top of a 2263px panel and its bottom can
  // never be scrolled to. The two classes only make sense together.
  expect(detailWrapper.className).toContain("min-[104rem]:max-h-[calc(100dvh-3rem)]");
  expect(detailWrapper.className).toContain("min-[104rem]:overflow-y-auto");
});

test("the sticky offset clears the top of the page without a hardcoded header height", () => {
  const { detailWrapper } = renderLayout();

  // Desktop has no sticky top header -- MobileNav is lg:hidden and the sidebar
  // is a sticky left column -- so top-6 is a gutter. If a sticky header is ever
  // added, this offset and the max-h calc both have to grow together.
  expect(detailWrapper.className).toContain("min-[104rem]:top-6");
});

test("both panes can shrink below their content width", () => {
  const { listWrapper, detailWrapper } = renderLayout();

  // A grid item's automatic minimum size is its min-content width (~896px for
  // these tables). Without min-w-0 the track refuses to shrink and the page
  // itself scrolls horizontally instead of the table.
  expect(listWrapper.className).toContain("min-w-0");
  expect(detailWrapper.className).toContain("min-w-0");
});

test("selecting a different record scrolls the detail pane back to the top", () => {
  const { detailWrapper, rerender } = renderLayout({ selectedId: 1 });

  // The pane is its own scroll container at the split breakpoint, and the node
  // survives the selection change, so without the reset record B would open at
  // record A's offset -- heading included.
  detailWrapper.scrollTop = 640;

  rerender(
    <ListDetailLayout
      selectedId={2}
      list={<section data-testid="list-pane">List</section>}
      detail={<section data-testid="detail-pane">Detail</section>}
    />
  );

  expect(detailWrapper.scrollTop).toBe(0);
});

test("re-rendering the same record leaves the detail pane's scroll position alone", () => {
  const { detailWrapper, rerender } = renderLayout({ selectedId: 1 });

  detailWrapper.scrollTop = 640;

  rerender(
    <ListDetailLayout
      selectedId={1}
      list={<section data-testid="list-pane">List</section>}
      detail={<section data-testid="detail-pane">Detail (saving...)</section>}
    />
  );

  // A save, a validation error, or any other in-record state change must not
  // yank the reader back to the top.
  expect(detailWrapper.scrollTop).toBe(640);
});

test("changing the selected record does not remount the detail subtree", () => {
  const mounted = vi.fn();

  function EditForm({ onMount }) {
    const [draft, setDraft] = useState("");
    useEffect(() => {
      onMount();
    }, [onMount]);

    return (
      <input
        aria-label="Draft"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
    );
  }

  const detail = <EditForm onMount={mounted} />;
  const list = <section>List</section>;
  const { rerender } = render(<ListDetailLayout selectedId={1} list={list} detail={detail} />);

  fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "half-typed note" } });
  const mountsBefore = mounted.mock.calls.length;

  rerender(<ListDetailLayout selectedId={2} list={list} detail={detail} />);

  // The scroll reset is a ref write, not a `key`. A key here would remount the
  // subtree and throw away in-progress edit-form state on every selection --
  // which is why the reset is deliberately not implemented that way.
  expect(screen.getByLabelText("Draft")).toHaveValue("half-typed note");
  expect(mounted.mock.calls.length).toBe(mountsBefore);
});

test("a conditional detail cannot take over the list pane", () => {
  const showDetail = false;
  const { container } = render(
    <ListDetailLayout
      selectedId={1}
      list={<section data-testid="list-pane">List</section>}
      detail={showDetail && <section data-testid="detail-pane">Detail</section>}
    />
  );
  const grid = container.querySelector("div.grid");

  // Positional `Children.toArray` used to drop the falsy child and shift the
  // remaining one into the list slot; with named props the list stays put and
  // the detail pane is simply empty.
  expect(grid.children[0]).toContainElement(screen.getByTestId("list-pane"));
  expect(grid.children[1].textContent).toBe("");
  expect(grid.children[1].className).toContain(listDetailLayoutClasses.stickyDetail);
});

test("a missing pane fails loudly instead of silently swapping roles", () => {
  // React logs the thrown error; the throw itself is the assertion.
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  expect(() => render(<ListDetailLayout list={<section>List</section>} />)).toThrow(
    /requires both a `list` and a `detail` prop/
  );
  expect(() => render(<ListDetailLayout detail={<section>Detail</section>} />)).toThrow(
    /requires both a `list` and a `detail` prop/
  );

  consoleError.mockRestore();
});
