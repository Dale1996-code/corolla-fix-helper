import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { SearchPage } from "./SearchPage";

// A library far larger than one page, so "renders only the current page" is a
// meaningful assertion rather than an accident of a small fixture.
const LIBRARY_SIZE = 1443;

function buildDocument(index) {
  return {
    id: index,
    title: `Corolla document ${index}`,
    originalFilename: `corolla-${index}.pdf`,
    system: "Engine",
    documentType: "Reference",
    source: "Manual",
    pageCount: 4,
    extractionStatus: "completed",
    isFavorite: false,
    snippet: `Snippet for document ${index}.`,
    snippetField: "Extracted text",
  };
}

// Serves /api/search/documents the way the real route does: a bounded page plus
// pagination metadata, honouring limit/offset and narrowing on q/system.
function createDocumentsResponder({ librarySize = LIBRARY_SIZE } = {}) {
  const requestedUrls = [];

  function respond(url) {
    const parsed = new URL(url, "http://localhost");
    const limit = Number(parsed.searchParams.get("limit") || 25);
    const offset = Number(parsed.searchParams.get("offset") || 0);
    const query = parsed.searchParams.get("q") || "";
    const system = parsed.searchParams.get("system") || "";

    // A keyword or a system filter narrows the matching set.
    let total = librarySize;
    if (query) total = 40;
    if (system) total = 12;

    const results = [];
    for (let index = offset + 1; index <= Math.min(offset + limit, total); index += 1) {
      results.push(buildDocument(index));
    }

    return {
      results,
      total,
      limit,
      offset,
      hasMore: offset + results.length < total,
      filters: { systems: ["Engine", "Cooling"], documentTypes: ["Reference"], tags: [] },
    };
  }

  return { requestedUrls, respond };
}

function createFetchMock(options = {}) {
  const documents = createDocumentsResponder(options);
  const emptyOther = (filters) => ({ results: [], total: 0, filters });

  const fetchMock = vi.fn((url) => {
    if (url.startsWith("/api/search/documents")) {
      documents.requestedUrls.push(url);

      if (options.documentsOverride) {
        const override = options.documentsOverride(url);
        if (override) return override;
      }

      return Promise.resolve({ ok: true, json: async () => documents.respond(url) });
    }

    if (url.startsWith("/api/search/symptoms")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          results: [
            {
              id: 21,
              title: "Idle flare on cold start",
              system: "Engine",
              status: "monitoring",
              confidence: "medium",
              linkedDocumentCount: 0,
              snippet: "RPM jumps for a few seconds.",
              snippetField: "Description",
            },
          ],
          total: 1,
          filters: { systems: ["Engine"], statuses: ["monitoring"] },
        }),
      });
    }

    if (url.startsWith("/api/search/procedures")) {
      return Promise.resolve({
        ok: true,
        json: async () => emptyOther({ systems: [], difficulties: [] }),
      });
    }

    if (url.startsWith("/api/search/notes")) {
      return Promise.resolve({
        ok: true,
        json: async () => emptyOther({ noteTypes: [], relatedEntityTypes: [] }),
      });
    }

    if (url === "/api/attachments/all") {
      return Promise.resolve({ ok: true, json: async () => ({ attachments: [], total: 0 }) });
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  });

  return { fetchMock, documents };
}

function renderSearchPage() {
  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );
}

async function findDocumentsSection() {
  const heading = await screen.findByRole("heading", { name: "Documents" });
  return heading.closest("section");
}

function documentCards(section) {
  return within(section).queryAllByRole("article");
}

function lastDocumentsUrl(documents) {
  return documents.requestedUrls[documents.requestedUrls.length - 1];
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("the idle Search page renders only the first page, never the whole library", async () => {
  const { fetchMock, documents } = createFetchMock();
  vi.stubGlobal("fetch", fetchMock);

  renderSearchPage();
  const section = await findDocumentsSection();

  await waitFor(() => expect(documentCards(section).length).toBe(25));

  expect(documentCards(section).length).toBeLessThan(LIBRARY_SIZE);
  expect(within(section).getByText("Corolla document 1")).toBeInTheDocument();
  expect(within(section).queryByText("Corolla document 26")).not.toBeInTheDocument();
  expect(within(section).queryByText(`Corolla document ${LIBRARY_SIZE}`)).not.toBeInTheDocument();

  // The initial request asks for a bounded page.
  expect(documents.requestedUrls[0]).toContain("limit=25");
});

test("no completed-search result count appears before a search is submitted", async () => {
  const { fetchMock } = createFetchMock();
  vi.stubGlobal("fetch", fetchMock);

  renderSearchPage();
  const section = await findDocumentsSection();

  await waitFor(() => expect(documentCards(section).length).toBe(25));

  // The pre-search state must read as a library listing, not as search output.
  expect(within(section).queryByText(/document results\./)).not.toBeInTheDocument();
  expect(
    within(section).getByText(
      "Showing 1–25 of 1,443 documents in your library. Search to narrow this list."
    )
  ).toBeInTheDocument();
});

test("submitting a search shows a completed-search counter for the bounded page", async () => {
  const { fetchMock, documents } = createFetchMock();
  vi.stubGlobal("fetch", fetchMock);

  renderSearchPage();
  const section = await findDocumentsSection();
  await waitFor(() => expect(documentCards(section).length).toBe(25));

  fireEvent.change(within(section).getByRole("textbox", { name: "Keyword" }), {
    target: { value: "brake" },
  });
  fireEvent.click(within(section).getByRole("button", { name: "Search" }));

  await waitFor(() =>
    expect(within(section).getByText("Showing 1–25 of 40 document results.")).toBeInTheDocument()
  );

  expect(documentCards(section).length).toBe(25);
  expect(lastDocumentsUrl(documents)).toBe(
    "/api/search/documents?q=brake&sort=relevance&limit=25"
  );
});

test("Next requests the following range and updates the counter", async () => {
  const { fetchMock, documents } = createFetchMock();
  vi.stubGlobal("fetch", fetchMock);

  renderSearchPage();
  const section = await findDocumentsSection();
  await waitFor(() => expect(documentCards(section).length).toBe(25));

  fireEvent.click(within(section).getByRole("button", { name: "Next" }));

  await waitFor(() =>
    expect(
      within(section).getByText(
        "Showing 26–50 of 1,443 documents in your library. Search to narrow this list."
      )
    ).toBeInTheDocument()
  );

  expect(lastDocumentsUrl(documents)).toContain("offset=25");
  expect(documentCards(section).length).toBe(25);
  expect(within(section).getByText("Corolla document 26")).toBeInTheDocument();
  expect(within(section).queryByText("Corolla document 1")).not.toBeInTheDocument();

  // And back again.
  fireEvent.click(within(section).getByRole("button", { name: "Previous" }));
  await waitFor(() => expect(within(section).getByText("Corolla document 1")).toBeInTheDocument());
  expect(lastDocumentsUrl(documents)).not.toContain("offset=");
});

test("Previous and Next are disabled at the first and last page", async () => {
  const { fetchMock } = createFetchMock({ librarySize: 30 });
  vi.stubGlobal("fetch", fetchMock);

  renderSearchPage();
  const section = await findDocumentsSection();
  await waitFor(() => expect(documentCards(section).length).toBe(25));

  const pager = within(section).getByRole("navigation", { name: "Document result pages" });

  expect(within(section).getByRole("button", { name: "Previous" })).toBeDisabled();
  expect(within(section).getByRole("button", { name: "Next" })).toBeEnabled();
  expect(pager.textContent).toContain("Page 1 of 2");

  fireEvent.click(within(section).getByRole("button", { name: "Next" }));

  await waitFor(() => expect(documentCards(section).length).toBe(5));
  expect(within(section).getByRole("button", { name: "Previous" })).toBeEnabled();
  expect(within(section).getByRole("button", { name: "Next" })).toBeDisabled();
  expect(within(section).getByText("Showing 26–30 of 30 documents in your library. Search to narrow this list."))
    .toBeInTheDocument();
});

test("pagination controls are hidden when a single page holds every result", async () => {
  const { fetchMock } = createFetchMock({ librarySize: 8 });
  vi.stubGlobal("fetch", fetchMock);

  renderSearchPage();
  const section = await findDocumentsSection();
  await waitFor(() => expect(documentCards(section).length).toBe(8));

  expect(within(section).queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
  expect(within(section).queryByRole("button", { name: "Previous" })).not.toBeInTheDocument();
});

test("changing the search query resets pagination to the first page", async () => {
  const { fetchMock, documents } = createFetchMock();
  vi.stubGlobal("fetch", fetchMock);

  renderSearchPage();
  const section = await findDocumentsSection();
  await waitFor(() => expect(documentCards(section).length).toBe(25));

  fireEvent.click(within(section).getByRole("button", { name: "Next" }));
  await waitFor(() => expect(lastDocumentsUrl(documents)).toContain("offset=25"));

  fireEvent.change(within(section).getByRole("textbox", { name: "Keyword" }), {
    target: { value: "brake" },
  });
  fireEvent.click(within(section).getByRole("button", { name: "Search" }));

  await waitFor(() =>
    expect(lastDocumentsUrl(documents)).toBe("/api/search/documents?q=brake&sort=relevance&limit=25")
  );
  expect(lastDocumentsUrl(documents)).not.toContain("offset=");
  expect(within(section).getByText("Showing 1–25 of 40 document results.")).toBeInTheDocument();
});

test("changing a filter resets pagination to the first page", async () => {
  const { fetchMock, documents } = createFetchMock();
  vi.stubGlobal("fetch", fetchMock);

  renderSearchPage();
  const section = await findDocumentsSection();
  await waitFor(() => expect(documentCards(section).length).toBe(25));

  fireEvent.click(within(section).getByRole("button", { name: "Next" }));
  await waitFor(() => expect(lastDocumentsUrl(documents)).toContain("offset=25"));

  fireEvent.change(within(section).getByRole("combobox", { name: "System" }), {
    target: { value: "Cooling" },
  });
  fireEvent.click(within(section).getByRole("button", { name: "Search" }));

  await waitFor(() =>
    expect(lastDocumentsUrl(documents)).toBe(
      "/api/search/documents?system=Cooling&sort=relevance&limit=25"
    )
  );
  expect(lastDocumentsUrl(documents)).not.toContain("offset=");
  expect(within(section).getByText("Showing 1–12 of 12 document results.")).toBeInTheDocument();
});

test("Clear returns the section to the bounded idle listing", async () => {
  const { fetchMock, documents } = createFetchMock();
  vi.stubGlobal("fetch", fetchMock);

  renderSearchPage();
  const section = await findDocumentsSection();
  await waitFor(() => expect(documentCards(section).length).toBe(25));

  fireEvent.change(within(section).getByRole("textbox", { name: "Keyword" }), {
    target: { value: "brake" },
  });
  fireEvent.click(within(section).getByRole("button", { name: "Search" }));
  await waitFor(() =>
    expect(within(section).getByText("Showing 1–25 of 40 document results.")).toBeInTheDocument()
  );

  fireEvent.click(within(section).getByRole("button", { name: "Clear" }));

  await waitFor(() =>
    expect(
      within(section).getByText(
        "Showing 1–25 of 1,443 documents in your library. Search to narrow this list."
      )
    ).toBeInTheDocument()
  );
  expect(lastDocumentsUrl(documents)).toBe("/api/search/documents?sort=relevance&limit=25");
});

test("Symptoms, Procedures, and Notes stay present below the paged Documents section", async () => {
  const { fetchMock } = createFetchMock();
  vi.stubGlobal("fetch", fetchMock);

  renderSearchPage();
  const documentsSection = await findDocumentsSection();
  await waitFor(() => expect(documentCards(documentsSection).length).toBe(25));

  for (const name of ["Symptoms", "Procedures", "Notes"]) {
    expect(screen.getByRole("heading", { name })).toBeInTheDocument();
  }

  // The lower sections keep their own results and their unpaged wording.
  const symptomsSection = screen.getByRole("heading", { name: "Symptoms" }).closest("section");
  expect(within(symptomsSection).getByText("Idle flare on cold start")).toBeInTheDocument();
  expect(
    within(symptomsSection).getByText("Showing all 1 symptom in your library.")
  ).toBeInTheDocument();

  // Notes came back empty and unsearched: an idle empty message, not a
  // "nothing matched your search" message.
  const notesSection = screen.getByRole("heading", { name: "Notes" }).closest("section");
  expect(within(notesSection).getByText("No notes saved yet.")).toBeInTheDocument();
});

test("loading, no-results, and error states still work on the paged section", async () => {
  let resolvePending;
  const pending = new Promise((resolve) => {
    resolvePending = resolve;
  });

  const { fetchMock } = createFetchMock({
    documentsOverride: (url) => {
      if (url.includes("q=slowquery")) {
        return pending.then(() => ({
          ok: true,
          json: async () => ({
            results: [],
            total: 0,
            limit: 25,
            offset: 0,
            hasMore: false,
            filters: {},
          }),
        }));
      }

      if (url.includes("q=boom")) {
        return Promise.resolve({
          ok: false,
          json: async () => ({ error: "Could not load search results." }),
        });
      }

      return null;
    },
  });
  vi.stubGlobal("fetch", fetchMock);

  renderSearchPage();
  const section = await findDocumentsSection();
  await waitFor(() => expect(documentCards(section).length).toBe(25));

  // Loading state.
  fireEvent.change(within(section).getByRole("textbox", { name: "Keyword" }), {
    target: { value: "slowquery" },
  });
  fireEvent.click(within(section).getByRole("button", { name: "Search" }));
  expect(await within(section).findByText("Loading documents...")).toBeInTheDocument();

  // No-results state after a real search.
  resolvePending();
  await waitFor(() =>
    expect(within(section).getByText("No documents matched this search.")).toBeInTheDocument()
  );
  expect(within(section).queryByText(/Showing/)).not.toBeInTheDocument();
  expect(within(section).queryByRole("button", { name: "Next" })).not.toBeInTheDocument();

  // Error state.
  fireEvent.change(within(section).getByRole("textbox", { name: "Keyword" }), {
    target: { value: "boom" },
  });
  fireEvent.click(within(section).getByRole("button", { name: "Search" }));

  await waitFor(() =>
    expect(within(section).getByText("Could not load search results.")).toBeInTheDocument()
  );
});

test("a stale page response cannot replace a newer one", async () => {
  let resolveStalePage;
  const stalePage = new Promise((resolve) => {
    resolveStalePage = resolve;
  });

  const { fetchMock } = createFetchMock({
    documentsOverride: (url) => {
      // Page 2 of the idle listing resolves slowly.
      if (url.includes("offset=25") && !url.includes("q=")) {
        return stalePage.then(() => ({
          ok: true,
          json: async () => ({
            results: [{ ...buildDocument(26), title: "STALE PAGE TWO" }],
            total: LIBRARY_SIZE,
            limit: 25,
            offset: 25,
            hasMore: true,
            filters: {},
          }),
        }));
      }

      return null;
    },
  });
  vi.stubGlobal("fetch", fetchMock);

  renderSearchPage();
  const section = await findDocumentsSection();
  await waitFor(() => expect(documentCards(section).length).toBe(25));

  // Ask for page 2, then hit Clear before it arrives. Clear stays enabled while
  // a request is in flight, so this race is reachable in the real UI.
  fireEvent.click(within(section).getByRole("button", { name: "Next" }));
  fireEvent.click(within(section).getByRole("button", { name: "Clear" }));

  // Clear's reload resolves immediately; wait for it to settle back on page 1.
  await within(section).findByRole("button", { name: "Search" });
  await waitFor(() => expect(within(section).getByText("Corolla document 1")).toBeInTheDocument());

  // The superseded page-2 response now lands; it must be discarded.
  resolveStalePage();
  await new Promise((resolve) => setTimeout(resolve, 30));

  expect(within(section).queryByText("STALE PAGE TWO")).not.toBeInTheDocument();
  expect(
    within(section).getByText(
      "Showing 1–25 of 1,443 documents in your library. Search to narrow this list."
    )
  ).toBeInTheDocument();
});
