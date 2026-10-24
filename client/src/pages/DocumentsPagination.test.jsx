import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { DocumentsPage } from "./DocumentsPage";
import { createDocumentsApi, jsonResponse } from "../test/documentsApiMock";

// N7, Documents: the page asks the server for ONE filtered, ordered page at a
// time and never holds the library. These tests pin what that changes for the
// owner -- bounded requests, whole-library filtering, no stale or flickering
// views, selection that survives a page it is not on -- over a synthetic
// library. The stand-in server is documentsApiMock.js; the real SQL is covered
// by server/test/documentListPagination.test.js.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="url">{`${location.pathname}${location.search}`}</span>;
}

function currentUrl() {
  return screen.getByTestId("url").textContent;
}

// 60 synthetic documents, "Doc 060" newest down to "Doc 001" oldest. Every 20th
// is Cooling (so Cooling is entirely beyond the first two pages), the rest
// alternate Brakes/Engine, and a few carry flags and a tag.
function buildLibrary() {
  return Array.from({ length: 60 }, (_, index) => {
    const id = 60 - index;
    const stamp = new Date(Date.UTC(2026, 0, id)).toISOString();

    return {
      id,
      title: `Doc ${String(id).padStart(3, "0")}`,
      originalFilename: `doc-${id}.pdf`,
      storedFilename: `doc-${id}.pdf`,
      system: id % 20 === 0 ? "Cooling" : id % 2 === 0 ? "Brakes" : "Engine",
      subsystem: "",
      documentType: id % 3 === 0 ? "Wiring Diagram" : "Reference",
      source: "",
      notes: "",
      extractionStatus: "completed",
      pageCount: 2,
      isFavorite: id % 10 === 0,
      isBookmarked: id % 15 === 0,
      tags: id === 1 ? ["Torque-Specs"] : [],
      createdAt: stamp,
      updatedAt: stamp,
    };
  });
}

function stubApi(library = buildLibrary(), extra) {
  const api = createDocumentsApi(library, { extra });
  const fetchMock = vi.fn(api.fetch);
  fetchMock.api = api;
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function renderPage(entry = "/documents") {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <DocumentsPage />
      <LocationProbe />
    </MemoryRouter>
  );
  await screen.findByText("Library controls");
}

function rowButtons() {
  return screen.queryAllByRole("button", { name: /^Select document: / });
}

function rowTitles() {
  return rowButtons().map((button) => button.getAttribute("aria-label").replace("Select document: ", ""));
}

function lastListRequest(fetchMock) {
  const { listRequests } = fetchMock.api;
  return listRequests[listRequests.length - 1];
}

function selectedHeading() {
  return screen.getByRole("heading", { level: 2, name: /^Doc \d{3}$/ }).textContent;
}

test("the first view is one bounded request, never the whole library", async () => {
  const fetchMock = stubApi();

  await renderPage();

  const { listRequests } = fetchMock.api;
  expect(listRequests).toHaveLength(1);
  expect(Object.fromEntries(listRequests[0])).toEqual({
    limit: "25",
    offset: "0",
    sort: "newest",
  });
  // No call asked for the unpaged list the page used to download.
  expect(
    fetchMock.mock.calls.filter(([url]) => String(url) === "/api/documents")
  ).toHaveLength(0);

  // Exactly one page of rows is rendered, and the counter is the server's.
  expect(rowButtons()).toHaveLength(25);
  expect(rowTitles()[0]).toBe("Doc 060");
  expect(rowTitles()[24]).toBe("Doc 036");
  expect(screen.getByText("Showing 1–25 of 60 documents.")).toBeInTheDocument();
});

test("Next and Previous request the matching offset and keep the counter honest", async () => {
  const fetchMock = stubApi();
  await renderPage();

  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Showing 26–50 of 60 documents.");
  expect(lastListRequest(fetchMock).get("offset")).toBe("25");
  expect(currentUrl()).toBe("/documents?page=2");
  expect(rowTitles()[0]).toBe("Doc 035");

  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Showing 51–60 of 60 documents.");
  expect(lastListRequest(fetchMock).get("offset")).toBe("50");
  expect(rowButtons()).toHaveLength(10);
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  await screen.findByText("Showing 26–50 of 60 documents.");
  expect(lastListRequest(fetchMock).get("offset")).toBe("25");
});

test("a filter searches the whole library, and its options come from the whole library", async () => {
  const fetchMock = stubApi();
  await renderPage();

  // Every Cooling document is beyond the 50 newest, so nothing on screen or in
  // any loaded page could have supplied this option: it came from the server.
  expect(
    within(screen.getByRole("combobox", { name: "System" })).getByRole("option", { name: "Cooling" })
  ).toBeInTheDocument();
  // Doc 020 is a Cooling document too, and it is not among the 25 rows loaded.
  expect(rowTitles()).not.toContain("Doc 020");

  fireEvent.change(screen.getByRole("combobox", { name: "System" }), {
    target: { value: "Cooling" },
  });

  await screen.findByText("Showing 1–3 of 3 documents. Filtered from 60 in your library.");
  expect(rowTitles()).toEqual(["Doc 060", "Doc 040", "Doc 020"]);
  expect(lastListRequest(fetchMock).get("system")).toBe("Cooling");
  expect(currentUrl()).toBe("/documents?system=Cooling");
  // One page of three rows needs no pager.
  expect(screen.queryByRole("navigation", { name: "Documents pages" })).not.toBeInTheDocument();
});

test("every control reaches the server as the matching parameter and resets the page", async () => {
  const fetchMock = stubApi();
  await renderPage("/documents?page=2");
  await screen.findByText("Showing 26–50 of 60 documents.");

  const choose = async (name, value, expectedParams) => {
    fireEvent.change(screen.getByRole("combobox", { name }), { target: { value } });
    await waitFor(() => {
      const request = lastListRequest(fetchMock);
      for (const [key, expected] of Object.entries(expectedParams)) {
        expect(request.get(key)).toBe(expected);
      }
    });
  };

  await choose("Sort", "oldest", { sort: "oldest", offset: "0" });
  expect(currentUrl()).toBe("/documents?sort=oldest");
  await waitFor(() => expect(rowTitles()[0]).toBe("Doc 001"));

  await choose("Sort", "title_asc", { sort: "title_asc" });
  await choose("Document type", "Wiring Diagram", { documentType: "Wiring Diagram" });
  await choose("Favorite", "favorites_only", { favorite: "true" });
  await choose("Bookmark", "bookmarked_only", { bookmarked: "true" });
  await choose("Tag", "all", {});

  // Only Doc 030 and Doc 060 are wiring diagrams that are favorites AND
  // bookmarked; server-side AND, then ordered A-Z.
  await screen.findByText(/Showing 1–2 of 2 documents/);
  expect(rowTitles()).toEqual(["Doc 030", "Doc 060"]);

  await choose("Favorite", "not_favorites", { favorite: "false" });
  await choose("Bookmark", "not_bookmarked", { bookmarked: "false" });
  // Back to all: the parameters go away rather than lingering as "all".
  await choose("Favorite", "all", {});
  expect(lastListRequest(fetchMock).has("favorite")).toBe(false);
});

test("a tag filter is applied by the server across the whole library", async () => {
  const fetchMock = stubApi();
  await renderPage();

  // Doc 001 is the oldest document, on page three of the unfiltered list.
  fireEvent.change(screen.getByRole("combobox", { name: "Tag" }), {
    target: { value: "Torque-Specs" },
  });

  await screen.findByText("Showing 1–1 of 1 document. Filtered from 60 in your library.");
  expect(rowTitles()).toEqual(["Doc 001"]);
  expect(lastListRequest(fetchMock).get("tag")).toBe("Torque-Specs");
});

test("a filter that matches nothing says so, and says how big the library is", async () => {
  stubApi();
  await renderPage("/documents?tag=no-such-tag");

  expect(
    await screen.findByText("No documents match these filters. 60 documents in your library.")
  ).toBeInTheDocument();
  expect(screen.getByText("Change the filters above to see more of your library.")).toBeInTheDocument();
  expect(screen.queryByRole("navigation", { name: "Documents pages" })).not.toBeInTheDocument();
});

test("an answer for an older view never replaces the view the owner moved to", async () => {
  let releaseBrakes;
  const brakesGate = new Promise((resolve) => {
    releaseBrakes = resolve;
  });

  const fetchMock = stubApi(buildLibrary(), (url, init, state) => {
    const [, query = ""] = url.split("?");
    const params = new URLSearchParams(query);

    if (url.startsWith("/api/documents?") && params.get("system") === "Brakes") {
      // Answers late -- after the owner has already chosen Engine.
      state.listRequests.push(params);
      return brakesGate.then(() =>
        jsonResponse({
          documents: [{ ...buildLibrary()[1], title: "Doc 058", system: "Brakes" }],
          total: 60,
          matched: 1,
        })
      );
    }

    return undefined;
  });

  await renderPage();

  fireEvent.change(screen.getByRole("combobox", { name: "System" }), { target: { value: "Brakes" } });
  fireEvent.change(screen.getByRole("combobox", { name: "System" }), { target: { value: "Engine" } });

  await waitFor(() => expect(lastListRequest(fetchMock).get("system")).toBe("Engine"));
  await waitFor(() => expect(screen.getByText(/of 30 documents/)).toBeInTheDocument());

  releaseBrakes();
  await new Promise((resolve) => setTimeout(resolve, 20));

  // The Engine view stands: its 30-document counter, no lone Brakes row.
  expect(screen.getByText(/of 30 documents/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Select document: Doc 058" })).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "System" })).toHaveValue("Engine");
});

test("controls stay mounted and the old rows stay put while a new view loads", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let intercepted = false;

  stubApi(buildLibrary(), (url, init, state) => {
    if (url.includes("sort=oldest") && !intercepted) {
      intercepted = true;
      return gate.then(() => {
        const library = [...state.library].reverse().slice(0, 25);
        return jsonResponse({ documents: library, total: 60, matched: 60 });
      });
    }

    return undefined;
  });

  await renderPage();
  const sort = screen.getByRole("combobox", { name: "Sort" });
  sort.focus();

  fireEvent.change(sort, { target: { value: "oldest" } });

  // Mid-flight: the very select the owner is holding is still the one in the
  // DOM, the previous rows are still readable, and the page says it is working.
  expect(screen.getByRole("combobox", { name: "Sort" })).toBe(sort);
  expect(screen.queryByText("Loading documents...")).not.toBeInTheDocument();
  expect(rowTitles()[0]).toBe("Doc 060");
  expect(screen.getByText("Updating...")).toBeInTheDocument();

  release();

  await waitFor(() => expect(rowTitles()[0]).toBe("Doc 001"));
  expect(screen.queryByText("Updating...")).not.toBeInTheDocument();
});

test("a first-load failure shows the error and no controls", async () => {
  stubApi(buildLibrary(), (url) =>
    url.startsWith("/api/documents?")
      ? jsonResponse({ error: "Could not load documents." }, { ok: false, status: 500 })
      : undefined
  );

  render(<MemoryRouter initialEntries={["/documents"]}><DocumentsPage /></MemoryRouter>);

  // The banner repeats the message as its title and its body.
  expect((await screen.findAllByText("Could not load documents.")).length).toBeGreaterThan(0);
  expect(screen.queryByText("Library controls")).not.toBeInTheDocument();
  expect(screen.queryByText("Loading documents...")).not.toBeInTheDocument();
});

test("a failure on a later page keeps the controls and the rows already on screen", async () => {
  stubApi(buildLibrary(), (url) =>
    url.includes("offset=25")
      ? jsonResponse({ error: "Database is busy." }, { ok: false, status: 500 })
      : undefined
  );
  await renderPage();

  fireEvent.click(screen.getByRole("button", { name: "Next" }));

  expect(await screen.findByText("Database is busy.")).toBeInTheDocument();
  // The owner can still change the filter to recover.
  expect(screen.getByRole("combobox", { name: "System" })).toBeInTheDocument();
  expect(rowButtons()).toHaveLength(25);
});

test("a deep link to a document outside the page and outside the filter still opens it", async () => {
  const fetchMock = stubApi();

  // Doc 003 is an Engine document; the list is filtered to Brakes.
  await renderPage("/documents?system=Brakes&documentId=3");

  await waitFor(() => expect(selectedHeading()).toBe("Doc 003"));
  expect(fetchMock.api.lookups).toEqual(["/api/documents/3"]);
  expect(rowTitles()).not.toContain("Doc 003");
  expect(currentUrl()).toBe("/documents?system=Brakes&documentId=3");
});

test("favoriting under a favorites-only filter refreshes the page and keeps the detail open", async () => {
  const fetchMock = stubApi();
  await renderPage("/documents?favorite=favorites_only&documentId=60");

  await waitFor(() => expect(selectedHeading()).toBe("Doc 060"));
  const requestsBefore = fetchMock.api.listRequests.length;

  // The stand-in's PUT is not part of the shared helper, so the test supplies it.
  vi.stubGlobal(
    "fetch",
    vi.fn((url, init = {}) => {
      if (url === "/api/documents/60" && init.method === "PUT") {
        const index = fetchMock.api.library.findIndex((document) => document.id === 60);
        fetchMock.api.library[index] = { ...fetchMock.api.library[index], isFavorite: false };
        return jsonResponse({ document: fetchMock.api.library[index] });
      }
      return fetchMock.api.fetch(url, init);
    })
  );

  fireEvent.click(screen.getByRole("button", { name: "Unfavorite" }));

  // The server was asked again, so the row that no longer matches leaves the
  // list; the detail panel does not go blank beside it.
  await waitFor(() => expect(fetchMock.api.listRequests.length).toBeGreaterThan(requestsBefore));
  await waitFor(() => expect(rowTitles()).not.toContain("Doc 060"));
  await waitFor(() => expect(selectedHeading()).toBe("Doc 060"));
  expect(screen.getByRole("button", { name: "Favorite" })).toBeInTheDocument();
});

test("uploading a document the current filter hides still opens it", async () => {
  const fetchMock = stubApi(buildLibrary(), (url, init, state) => {
    if (url === "/api/documents/upload" && init.method === "POST") {
      const uploaded = {
        ...buildLibrary()[0],
        id: 99,
        title: "Doc 099",
        system: "Engine",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
      };
      state.library = [uploaded, ...state.library];
      return jsonResponse({ document: uploaded });
    }
    return undefined;
  });

  await renderPage("/documents?system=Brakes");

  fireEvent.click(await screen.findByRole("button", { name: /Upload PDF/i, expanded: false }));
  fireEvent.change(await screen.findByLabelText(/PDF file/), {
    target: { files: [new File(["%PDF-1.4"], "new.pdf", { type: "application/pdf" })] },
  });
  fireEvent.change(screen.getByPlaceholderText("Engine, Brakes, Electrical..."), { target: { value: "Engine" } });
  fireEvent.change(screen.getByPlaceholderText("Repair Manual, Wiring Diagram..."), { target: { value: "Reference" } });
  fireEvent.submit(screen.getByRole("button", { name: "Upload PDF" }).closest("form"));

  await waitFor(() => expect(currentUrl()).toBe("/documents?system=Brakes&documentId=99"));
  await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Doc 099" })).toBeInTheDocument());
  // It is an Engine document, so the Brakes list does not include it, and it
  // was reached by id rather than from a loaded list.
  expect(rowTitles()).not.toContain("Doc 099");
  expect(fetchMock.api.lookups).toContain("/api/documents/99");
  // The filter options were refreshed too, so a brand-new system could appear.
  expect(fetchMock.api.filterOptionRequests).toBeGreaterThanOrEqual(2);
});

test("deleting the only row on the last page steps back to the page before it", async () => {
  const library = buildLibrary().slice(0, 26); // Doc 060 .. Doc 035: page 2 holds one row
  const fetchMock = stubApi(library, (url, init, state) => {
    if (url === "/api/documents/35" && init.method === "DELETE") {
      state.library = state.library.filter((document) => document.id !== 35);
      return jsonResponse({ message: "Document deleted." });
    }
    return undefined;
  });
  vi.stubGlobal("confirm", vi.fn(() => true));

  await renderPage("/documents?page=2");
  await screen.findByText("Showing 26–26 of 26 documents.");
  expect(rowTitles()).toEqual(["Doc 035"]);

  fireEvent.click(screen.getByRole("button", { name: "Delete document" }));

  // Page 2 no longer exists: the page falls back to 1 instead of stranding the
  // owner on an empty page, and the counter reflects 25 documents.
  await waitFor(() => expect(currentUrl()).toBe("/documents"));
  await screen.findByText("Showing 1–25 of 25 documents.");
  expect(rowButtons()).toHaveLength(25);
  expect(fetchMock.api.listRequests.some((request) => request.get("offset") === "25")).toBe(true);
});

test("the pager is a labelled navigation with a full-size tap target", async () => {
  stubApi();
  await renderPage();

  const pager = screen.getByRole("navigation", { name: "Documents pages" });
  const previous = within(pager).getByRole("button", { name: "Previous" });
  const next = within(pager).getByRole("button", { name: "Next" });

  expect(previous).toBeDisabled();
  expect(next).toBeEnabled();
  // 44px (min-h-11) is the touch-target floor; the old buttons were ~28px.
  expect(previous.className).toContain("min-h-11");
  expect(next.className).toContain("min-h-11");
  expect(within(pager).getByText("Page", { exact: false }).textContent).toContain("Page 1 of 3");
});
