import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { ProceduresPage } from "./ProceduresPage";
import { buildProcedure, createProceduresApi } from "../test/proceduresApiMock";

// N7 for Procedures: the list is paged, filtered, and sorted by the server, so
// the page holds one page of rows and never downloads the whole collection.
// Every record here is synthetic.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// 60 procedures. `buildProcedure` stamps each one a second after the last, so
// "Newest" is highest id first: page 1 is 60-36, page 2 is 35-11, page 3 is 10-1.
const PROCEDURES = Array.from({ length: 60 }, (_, index) =>
  buildProcedure(index + 1, { system: index % 2 === 0 ? "Brakes" : "Engine" })
);

function UrlProbe() {
  const location = useLocation();

  return <span data-testid="url">{`${location.pathname}${location.search}`}</span>;
}

const currentUrl = () => screen.getByTestId("url").textContent;

function renderProcedures({ procedures = PROCEDURES, entry = "/procedures", extra } = {}) {
  const api = createProceduresApi({ procedures }, { extra });
  vi.stubGlobal("fetch", vi.fn(api.fetch));

  render(
    <MemoryRouter initialEntries={[entry]}>
      <ProceduresPage />
      <UrlProbe />
    </MemoryRouter>
  );

  return api;
}

const rowTitles = () =>
  screen
    .queryAllByRole("button", { name: /^Select procedure:/ })
    .map((button) => button.getAttribute("aria-label").replace("Select procedure: ", ""));

// "Page 2 of 3" is split across <span>s for its bold numbers.
async function expectPageIndicator(expectedText) {
  await waitFor(() =>
    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName === "SPAN" && element.textContent.replace(/\s+/g, " ") === expectedText
      )
    ).toBeInTheDocument()
  );
}

test("the first view is one bounded page, with no whole-collection downloads", async () => {
  const api = renderProcedures();

  await waitFor(() => expect(rowTitles()).toHaveLength(25));
  expect(rowTitles()[0]).toBe("Procedure 060");
  expect(rowTitles().at(-1)).toBe("Procedure 036");
  expect(screen.getByText("Showing 1–25 of 60 procedures.")).toBeInTheDocument();
  // The banner counts the library, not the page.
  expect(screen.getByText("60 procedures in your library.")).toBeInTheDocument();
  await expectPageIndicator("Page 1 of 3");

  expect(api.listRequests).toHaveLength(1);
  expect(Object.fromEntries(api.listRequests[0])).toEqual({
    limit: "25",
    offset: "0",
    sort: "newest",
  });
  // Nothing asked for /api/procedures, /api/documents, or /api/symptoms whole.
  expect(api.fullListRequests).toEqual([]);
});

test("Next and Previous walk the page boundaries the server reports", async () => {
  renderProcedures();
  await waitFor(() => expect(rowTitles()).toHaveLength(25));

  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(rowTitles()[0]).toBe("Procedure 035"));
  expect(rowTitles().at(-1)).toBe("Procedure 011");
  expect(screen.getByText("Showing 26–50 of 60 procedures.")).toBeInTheDocument();
  expect(currentUrl()).toBe("/procedures?page=2");

  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(rowTitles()).toHaveLength(10));
  expect(rowTitles().at(-1)).toBe("Procedure 001");
  await expectPageIndicator("Page 3 of 3");
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  await waitFor(() => expect(rowTitles()[0]).toBe("Procedure 035"));
  expect(currentUrl()).toBe("/procedures?page=2");
});

test("a filter is applied over the whole library and starts again from page 1", async () => {
  const api = renderProcedures({ entry: "/procedures?page=2" });
  await waitFor(() => expect(rowTitles()[0]).toBe("Procedure 035"));

  fireEvent.change(screen.getByLabelText("System filter"), { target: { value: "Engine" } });

  // 30 Engine procedures over two pages; the filter dropped `page`.
  await waitFor(() => expect(screen.getByText("Showing 1–25 of 30 procedures.")).toBeInTheDocument());
  expect(currentUrl()).toBe("/procedures?system=Engine");
  expect(api.listRequests.at(-1).get("system")).toBe("Engine");
  expect(api.listRequests.at(-1).get("offset")).toBe("0");
  await expectPageIndicator("Page 1 of 2");
});

test("a procedure outside the loaded page opens by id, and a missing one drops out of the URL", async () => {
  // Procedure 3 is on page 3; the deep link opens it without loading that page.
  const api = renderProcedures({ entry: "/procedures?procedureId=3" });

  expect(await screen.findByRole("heading", { name: "Procedure 003" })).toBeInTheDocument();
  expect(api.lookups).toEqual(["/api/procedures/3"]);
  expect(rowTitles()).not.toContain("Procedure 003");
  expect(currentUrl()).toBe("/procedures?procedureId=3");
});

test("an id no procedure has is cleared from the URL by the server's 404", async () => {
  const api = renderProcedures({ entry: "/procedures?procedureId=999" });

  await waitFor(() => expect(currentUrl()).toBe("/procedures"));
  expect(api.lookups).toEqual(["/api/procedures/999"]);
  // The page falls back to its first row.
  expect(await screen.findByRole("heading", { name: "Procedure 060" })).toBeInTheDocument();
});

test("a page past the end steps back to the last real page", async () => {
  renderProcedures({ entry: "/procedures?page=9" });

  await waitFor(() => expect(currentUrl()).toBe("/procedures?page=3"));
  await waitFor(() => expect(rowTitles()).toHaveLength(10));
  await expectPageIndicator("Page 3 of 3");
});

test("creating a procedure shows it at once, and the reload refreshes the counts", async () => {
  const api = renderProcedures();
  await waitFor(() => expect(rowTitles()).toHaveLength(25));

  fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: "Brand new job" } });
  fireEvent.click(screen.getByRole("button", { name: "Save procedure" }));

  expect(await screen.findByText("Procedure saved.")).toBeInTheDocument();
  expect(await screen.findByRole("heading", { name: "Brand new job" })).toBeInTheDocument();
  expect(api.writes.filter((write) => write.method === "POST")).toHaveLength(1);
  await waitFor(() => expect(screen.getByText("61 procedures in your library.")).toBeInTheDocument());
  // The server's own page is what the list shows afterwards.
  await waitFor(() => expect(rowTitles()[0]).toBe("Brand new job"));
}, 10000);

test("deleting the only row on the last page steps back a page", async () => {
  const library = PROCEDURES.slice(0, 51);
  const api = renderProcedures({ procedures: library, entry: "/procedures?page=3" });
  await waitFor(() => expect(rowTitles()).toHaveLength(1));
  expect(rowTitles()[0]).toBe("Procedure 001");

  vi.spyOn(window, "confirm").mockReturnValue(true);
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

  await waitFor(() => expect(currentUrl()).toBe("/procedures?page=2"));
  await waitFor(() => expect(rowTitles()).toHaveLength(25));
  expect(api.writes.some((write) => write.method === "DELETE")).toBe(true);
  expect(screen.getByText("50 procedures in your library.")).toBeInTheDocument();
}, 10000);
