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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
