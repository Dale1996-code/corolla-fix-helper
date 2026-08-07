import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "./App";
import { navigationItems } from "./lib/navigation";
import { formatPageTitle } from "./lib/pageTitle";

// App renders whichever page matches the route, and several of those pages
// fetch on mount. The catch-all route is the thing under test here, so every
// request just resolves to an empty payload.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          documents: [],
          summary: {},
          favoriteDocuments: [],
          recentDocuments: [],
          recentSymptoms: [],
          recentProcedures: [],
          recentNotes: [],
          activeSymptoms: [],
          recentActivity: [],
          tags: [],
          checklists: [],
          attachments: [],
          results: [],
          filters: {},
          pagination: { total: 0, limit: 25, offset: 0, hasMore: false },
        }),
      })
    )
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("an unknown route renders the Not Found page instead of an empty screen", () => {
  render(
    <MemoryRouter initialEntries={["/this-page-does-not-exist"]}>
      <App />
    </MemoryRouter>
  );

  expect(screen.getByRole("heading", { name: /page not found/i })).toBeInTheDocument();
  expect(screen.getByText("/this-page-does-not-exist")).toBeInTheDocument();
});

test("the Not Found page links back to the documents page", async () => {
  render(
    <MemoryRouter initialEntries={["/this-page-does-not-exist"]}>
      <App />
    </MemoryRouter>
  );

  const backLink = screen.getByRole("link", { name: /go to documents/i });
  expect(backLink).toHaveAttribute("href", "/documents");

  fireEvent.click(backLink);

  expect(screen.queryByRole("heading", { name: /page not found/i })).not.toBeInTheDocument();
  expect(await screen.findByRole("heading", { name: /documents/i })).toBeInTheDocument();
});

test("a known route still renders its own page and no Not Found page", async () => {
  render(
    <MemoryRouter initialEntries={["/notes"]}>
      <App />
    </MemoryRouter>
  );

  expect(await screen.findByRole("heading", { name: /notes/i })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: /page not found/i })).not.toBeInTheDocument();
});

test("the root route still redirects to documents rather than falling through to Not Found", async () => {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <App />
    </MemoryRouter>
  );

  expect(await screen.findByRole("heading", { name: /documents/i })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: /page not found/i })).not.toBeInTheDocument();
});

test("a deep unknown path renders the Not Found page too", () => {
  render(
    <MemoryRouter initialEntries={["/documents/42/edit"]}>
      <App />
    </MemoryRouter>
  );

  expect(screen.getByRole("heading", { name: /page not found/i })).toBeInTheDocument();
});

// The H5 identity contract, asserted rather than described: one visible name
// per feature, used by the nav item, by the destination page's own <h1>, and by
// the browser tab. A nav label that drifts from its page heading -- the old
// "Checklists" -> "Repair Checklists" mismatch -- fails here.
test.each(navigationItems.map((item) => [item.label, item.to]))(
  "the %s nav item routes to a page headed %s and titles the tab to match",
  async (label, to) => {
    render(
      <MemoryRouter initialEntries={[to]}>
        <App />
      </MemoryRouter>
    );

    expect(await screen.findByRole("heading", { level: 1, name: label })).toBeInTheDocument();
    expect(document.title).toBe(formatPageTitle(label));
  }
);

test("the Not Found page titles the tab too, rather than leaving a stale one", async () => {
  render(
    <MemoryRouter initialEntries={["/this-page-does-not-exist"]}>
      <App />
    </MemoryRouter>
  );

  expect(document.title).toBe("Page not found | Corolla Fix Helper");
});

// Desktop and mobile render the same navigationItems list, so this is really a
// guard against someone re-hardcoding one of them.
test("every navigation destination is reachable and correctly targeted", () => {
  render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <App />
    </MemoryRouter>
  );

  for (const item of navigationItems) {
    const links = screen.getAllByRole("link", { name: item.label });
    expect(links.length).toBeGreaterThan(0);

    for (const link of links) {
      expect(link).toHaveAttribute("href", item.to);
    }
  }
});
