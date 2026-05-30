import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { SearchPage } from "./SearchPage";

function jsonResponse(payload, ok = true) {
  return Promise.resolve({
    ok,
    json: async () => payload,
  });
}

function emptySearchResponse(filters = {}) {
  return {
    results: [],
    total: 0,
    filters,
  };
}

function createEmptySearchFetchMock() {
  return vi.fn((url) => {
    if (url === "/api/search/documents?sort=relevance") {
      return jsonResponse(
        emptySearchResponse({
          systems: ["Engine"],
          documentTypes: ["Reference"],
        })
      );
    }

    if (url === "/api/search/symptoms?sort=newest") {
      return jsonResponse(
        emptySearchResponse({
          systems: ["Engine"],
          statuses: ["monitoring"],
        })
      );
    }

    if (url === "/api/search/procedures?sort=newest") {
      return jsonResponse(
        emptySearchResponse({
          systems: ["Engine"],
          difficulties: ["beginner"],
        })
      );
    }

    if (url === "/api/search/notes?sort=newest") {
      return jsonResponse(
        emptySearchResponse({
          noteTypes: ["observation"],
          relatedEntityTypes: ["symptom"],
        })
      );
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  });
}

function createPendingPromise() {
  return new Promise(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("SearchPage shows the Ask panel empty state above document search", async () => {
  const fetchMock = createEmptySearchFetchMock();
  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askHeading = await screen.findByRole("heading", {
    name: "Ask your documents",
  });
  const documentsHeading = screen.getByRole("heading", { name: "Documents" });
  expect(askHeading.compareDocumentPosition(documentsHeading)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING
  );

  const askSection = askHeading.closest("section");
  expect(askSection).not.toBeNull();
  expect(
    within(askSection).getByText("Type a question about your uploaded documents to begin.")
  ).toBeInTheDocument();

  fireEvent.click(within(askSection).getByRole("button", { name: "Ask" }));

  expect(
    within(askSection).getByText("Enter a question before asking.")
  ).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalledWith(
    "/api/ask",
    expect.objectContaining({ method: "POST" })
  );
});

test("SearchPage shows loading state while Ask waits for an answer", async () => {
  const baseSearchFetchMock = createEmptySearchFetchMock();
  const fetchMock = vi.fn((url, options) => {
    if (url === "/api/ask") {
      return createPendingPromise();
    }

    return baseSearchFetchMock(url, options);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askSection = (
    await screen.findByRole("heading", { name: "Ask your documents" })
  ).closest("section");
  expect(askSection).not.toBeNull();

  fireEvent.change(within(askSection).getByRole("textbox", { name: "Question" }), {
    target: { value: "What is the oil drain plug torque?" },
  });
  fireEvent.click(within(askSection).getByRole("button", { name: "Ask" }));

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ask",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: "What is the oil drain plug torque?" }),
      })
    );
  });

  expect(
    within(askSection).getByRole("button", { name: "Asking..." })
  ).toBeDisabled();
  expect(within(askSection).getByText("Asking your documents...")).toBeInTheDocument();
});

test("SearchPage shows AI not configured state from Ask response", async () => {
  const baseSearchFetchMock = createEmptySearchFetchMock();
  const fetchMock = vi.fn((url, options) => {
    if (url === "/api/ask") {
      return jsonResponse({
        question: "What is the oil drain plug torque?",
        status: "ai_not_configured",
        answer:
          "AI is not configured yet. Set OPENAI_API_KEY in the server environment to enable Ask.",
        citations: [],
      });
    }

    return baseSearchFetchMock(url, options);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askSection = (
    await screen.findByRole("heading", { name: "Ask your documents" })
  ).closest("section");
  expect(askSection).not.toBeNull();

  fireEvent.change(within(askSection).getByRole("textbox", { name: "Question" }), {
    target: { value: "What is the oil drain plug torque?" },
  });
  fireEvent.click(within(askSection).getByRole("button", { name: "Ask" }));

  expect(await within(askSection).findByText("AI not configured")).toBeInTheDocument();
  expect(
    within(askSection).getByText(
      "AI is not configured yet. Set OPENAI_API_KEY in the server environment to enable Ask."
    )
  ).toBeInTheDocument();
  expect(within(askSection).queryByText("Sources")).not.toBeInTheDocument();
});

test("SearchPage shows not-found state from Ask response", async () => {
  const baseSearchFetchMock = createEmptySearchFetchMock();
  const fetchMock = vi.fn((url, options) => {
    if (url === "/api/ask") {
      return jsonResponse({
        question: "What is the water pump torque?",
        status: "not_found",
        answer: "The uploaded documents do not contain enough information to answer that.",
        citations: [],
      });
    }

    return baseSearchFetchMock(url, options);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askSection = (
    await screen.findByRole("heading", { name: "Ask your documents" })
  ).closest("section");
  expect(askSection).not.toBeNull();

  fireEvent.change(within(askSection).getByRole("textbox", { name: "Question" }), {
    target: { value: "What is the water pump torque?" },
  });
  fireEvent.click(within(askSection).getByRole("button", { name: "Ask" }));

  expect(await within(askSection).findByText("No answer found")).toBeInTheDocument();
  expect(
    within(askSection).getByText(
      "The uploaded documents do not contain enough information to answer that."
    )
  ).toBeInTheDocument();
  expect(within(askSection).queryByText("Sources")).not.toBeInTheDocument();
});

test("SearchPage shows an answered Ask response with clickable citation cards", async () => {
  const baseSearchFetchMock = createEmptySearchFetchMock();
  const citationSnippet =
    "oil drain plug torque is 27 ft-lb and should be confirmed with a torque wrench.";
  const fetchMock = vi.fn((url, options) => {
    if (url === "/api/ask") {
      return jsonResponse({
        question: "What is the oil drain plug torque?",
        status: "answered",
        answer: "The oil drain plug torque is 27 ft-lb.",
        citations: [
          {
            documentId: 42,
            documentTitle: "Fake Torque Guide",
            originalFilename: "fake-torque-guide.pdf",
            pageNumber: 3,
            chunkIndex: 0,
            snippet: citationSnippet,
          },
        ],
      });
    }

    return baseSearchFetchMock(url, options);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askSection = (
    await screen.findByRole("heading", { name: "Ask your documents" })
  ).closest("section");
  expect(askSection).not.toBeNull();

  fireEvent.change(within(askSection).getByRole("textbox", { name: "Question" }), {
    target: { value: "What is the oil drain plug torque?" },
  });
  fireEvent.click(within(askSection).getByRole("button", { name: "Ask" }));

  expect(await within(askSection).findByText("Answer")).toBeInTheDocument();
  expect(
    within(askSection).getByText("The oil drain plug torque is 27 ft-lb.")
  ).toBeInTheDocument();
  expect(within(askSection).getByText("Sources")).toBeInTheDocument();

  const citationLink = within(askSection).getByRole("link", {
    name: "Open source Fake Torque Guide Page 3",
  });
  expect(citationLink).toHaveAttribute(
    "href",
    "/documents?documentId=42#document-library"
  );
  expect(within(citationLink).getByText("Fake Torque Guide")).toBeInTheDocument();
  expect(within(citationLink).getByText("Page 3")).toBeInTheDocument();
  expect(within(citationLink).getByText(citationSnippet)).toBeInTheDocument();
});

test("SearchPage shows request error state when Ask fails", async () => {
  const baseSearchFetchMock = createEmptySearchFetchMock();
  const fetchMock = vi.fn((url, options) => {
    if (url === "/api/ask") {
      return jsonResponse({ error: "Ask service failed." }, false);
    }

    return baseSearchFetchMock(url, options);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askSection = (
    await screen.findByRole("heading", { name: "Ask your documents" })
  ).closest("section");
  expect(askSection).not.toBeNull();

  fireEvent.change(within(askSection).getByRole("textbox", { name: "Question" }), {
    target: { value: "Why did the Ask request fail?" },
  });
  fireEvent.click(within(askSection).getByRole("button", { name: "Ask" }));

  expect(await within(askSection).findByText("Could not ask documents")).toBeInTheDocument();
  expect(within(askSection).getByText("Ask service failed.")).toBeInTheDocument();
  expect(within(askSection).queryByText("Sources")).not.toBeInTheDocument();
});

test("SearchPage renders separate search sections for all entity types", async () => {
  const fetchMock = vi.fn((url) => {
    if (url === "/api/search/documents?sort=relevance") {
      return jsonResponse({
        results: [],
        total: 0,
        filters: {
          systems: ["Engine"],
          documentTypes: ["Reference"],
        },
      });
    }

    if (url === "/api/search/symptoms?sort=newest") {
      return jsonResponse({
        results: [],
        total: 0,
        filters: {
          systems: ["Engine"],
          statuses: ["monitoring"],
        },
      });
    }

    if (url === "/api/search/procedures?sort=newest") {
      return jsonResponse({
        results: [],
        total: 0,
        filters: {
          systems: ["Engine"],
          difficulties: ["beginner"],
        },
      });
    }

    if (url === "/api/search/notes?sort=newest") {
      return jsonResponse({
        results: [],
        total: 0,
        filters: {
          noteTypes: ["observation"],
          relatedEntityTypes: ["symptom"],
        },
      });
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  expect(await screen.findByRole("heading", { name: "Documents" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Symptoms" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Procedures" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Notes" })).toBeInTheDocument();

  expect(screen.getAllByRole("button", { name: "Search" })).toHaveLength(4);
  expect(screen.getAllByRole("button", { name: "Clear" })).toHaveLength(4);
  expect(screen.getAllByRole("textbox", { name: "Keyword" })).toHaveLength(4);
});

test("SearchPage lets one section search independently", async () => {
  const fetchMock = vi.fn((url) => {
    if (url === "/api/search/documents?sort=relevance") {
      return jsonResponse({
        results: [
          {
            id: 11,
            title: "Throttle body reference",
            originalFilename: "throttle-body.pdf",
            system: "Engine",
            documentType: "Reference",
            source: "Manual",
            pageCount: 2,
            extractionStatus: "completed",
            isFavorite: false,
            snippet: "Throttle body cleaning and airflow checks.",
            snippetField: "Extracted text",
          },
        ],
        total: 1,
        filters: {
          systems: ["Engine"],
          documentTypes: ["Reference"],
        },
      });
    }

    if (url === "/api/search/symptoms?sort=newest") {
      return jsonResponse({
        results: [
          {
            id: 21,
            title: "Idle flare on cold start",
            system: "Engine",
            status: "monitoring",
            confidence: "medium",
            linkedDocumentCount: 1,
            snippet: "RPM jumps for a few seconds.",
            snippetField: "Description",
          },
        ],
        total: 1,
        filters: {
          systems: ["Engine"],
          statuses: ["monitoring"],
        },
      });
    }

    if (url === "/api/search/symptoms?q=idle&sort=newest") {
      return jsonResponse({
        results: [
          {
            id: 21,
            title: "Idle flare on cold start",
            system: "Engine",
            status: "monitoring",
            confidence: "medium",
            linkedDocumentCount: 1,
            snippet: "RPM jumps for a few seconds.",
            snippetField: "Description",
          },
        ],
        total: 1,
        filters: {
          systems: ["Engine"],
          statuses: ["monitoring"],
        },
      });
    }

    if (url === "/api/search/procedures?sort=newest") {
      return jsonResponse({
        results: [],
        total: 0,
        filters: {
          systems: ["Engine"],
          difficulties: ["beginner"],
        },
      });
    }

    if (url === "/api/search/notes?sort=newest") {
      return jsonResponse({
        results: [
          {
            id: 31,
            title: "Cold-start idle note",
            noteType: "observation",
            relatedEntityType: "symptom",
            relatedEntityId: 21,
            linkedTitle: "Idle flare on cold start",
            snippet: "Idle settles after throttle body cleaning.",
            snippetField: "Content",
          },
        ],
        total: 1,
        filters: {
          noteTypes: ["observation"],
          relatedEntityTypes: ["symptom"],
        },
      });
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const symptomsSection = (await screen.findByRole("heading", { name: "Symptoms" })).closest(
    "section"
  );
  expect(symptomsSection).not.toBeNull();

  fireEvent.change(within(symptomsSection).getByRole("textbox", { name: "Keyword" }), {
    target: { value: "idle" },
  });
  fireEvent.click(within(symptomsSection).getByRole("button", { name: "Search" }));

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith("/api/search/symptoms?q=idle&sort=newest");
  });

  expect(
    within(symptomsSection).getByRole("link", { name: "Open symptom Idle flare on cold start" })
  ).toHaveAttribute("href", "/symptoms?symptomId=21#symptom-library");

  const notesSection = screen.getByRole("heading", { name: "Notes" }).closest("section");
  expect(notesSection).not.toBeNull();
  expect(
    within(notesSection).getByRole("link", { name: "Open note Cold-start idle note" })
  ).toHaveAttribute("href", "/notes?noteId=31#note-library");

  expect(screen.getByText("Throttle body reference")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith("/api/search/documents?sort=relevance");
  expect(fetchMock).toHaveBeenCalledWith("/api/search/procedures?sort=newest");
  expect(fetchMock).toHaveBeenCalledWith("/api/search/notes?sort=newest");
});
