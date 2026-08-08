import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { ListDetailLayout, listDetailLayoutClasses } from "./ListDetailLayout";

// jsdom has no layout engine, so these assert the layout *semantics* -- which
// primitive is used, which breakpoint gates the split, which pane is sticky --
// rather than pixel results. The pixel behaviour is covered by the Playwright
// viewport sweep described in the H6 notes; what jsdom can protect is that the
// classes survive a refactor. Sizes and viewport behaviour are asserted in the
// browser, not here.

function renderLayout() {
  const { container } = render(
    <ListDetailLayout>
      <section data-testid="list-pane">List</section>
      <section data-testid="detail-pane">Detail</section>
    </ListDetailLayout>
  );
  const grid = container.querySelector("div.grid");
  return { grid, listWrapper: grid.children[0], detailWrapper: grid.children[1] };
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

test("the split breakpoint is above every laptop width, not Tailwind's xl", () => {
  const { grid } = renderLayout();

  // xl (1280px) is what caused H6: it split a content box that was never wider
  // than 1056px, leaving the list ~486px against a ~896px table.
  expect(grid.className).not.toContain("xl:grid-cols");
  expect(listDetailLayoutClasses.splitBreakpoint).toBe("min-[1664px]");
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
  expect(detailWrapper.className).toContain("min-[1664px]:max-h-[calc(100dvh-3rem)]");
  expect(detailWrapper.className).toContain("min-[1664px]:overflow-y-auto");
});

test("the sticky offset clears the top of the page without a hardcoded header height", () => {
  const { detailWrapper } = renderLayout();

  // Desktop has no sticky top header -- MobileNav is lg:hidden and the sidebar
  // is a sticky left column -- so top-6 is a gutter. If a sticky header is ever
  // added, this offset and the max-h calc both have to grow together.
  expect(detailWrapper.className).toContain("min-[1664px]:top-6");
});

test("both panes can shrink below their content width", () => {
  const { listWrapper, detailWrapper } = renderLayout();

  // A grid item's automatic minimum size is its min-content width (~896px for
  // these tables). Without min-w-0 the track refuses to shrink and the page
  // itself scrolls horizontally instead of the table.
  expect(listWrapper.className).toContain("min-w-0");
  expect(detailWrapper.className).toContain("min-w-0");
});
