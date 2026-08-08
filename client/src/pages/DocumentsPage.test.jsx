import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { DocumentsPage } from "./DocumentsPage";

function jsonResponse(payload, ok = true) {
  return Promise.resolve({ ok, json: async () => payload });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("DocumentsPage shows favorite, bookmark, and tag organization details", async () => {
  const fetchMock = vi.fn((url) => {
    if (url === "/api/documents") {
      return jsonResponse({ documents: [{ id: 1, title: "Sample Maintenance Schedule", originalFilename: "sample.pdf", storedFilename: "sample-copy.pdf", system: "Engine", subsystem: "Routine Service", documentType: "Maintenance Schedule", source: "Seed Data", notes: "Sample note", extractionStatus: "completed", pageCount: 1, isFavorite: true, isBookmarked: true, tags: ["maintenance", "engine"], createdAt: "2026-04-15T10:00:00.000Z", updatedAt: "2026-04-17T09:00:00.000Z" }], total: 1 });
    }
    if (url === "/api/settings") {
      return jsonResponse({ documentDefaults: { commonSystems: ["Engine"], documentTypes: ["Maintenance Schedule"] } });
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<MemoryRouter initialEntries={["/documents"]}><DocumentsPage /></MemoryRouter>);

  // Tag chips render with a leading hash in both the list and detail panels.
  expect((await screen.findAllByText("#maintenance")).length).toBeGreaterThan(0);
  expect(screen.getByText("Bookmarked")).toBeInTheDocument();
});

test("DocumentsPage saves bookmark flag and tags when editing details", async () => {
  const baseDocument = { id: 5, title: "Brake Job", originalFilename: "brake.pdf", storedFilename: "brake-copy.pdf", system: "Brakes", subsystem: "", documentType: "Procedure", source: "", notes: "", extractionStatus: "completed", pageCount: 3, isFavorite: false, isBookmarked: false, tags: [], createdAt: "2026-04-15T10:00:00.000Z", updatedAt: "2026-04-17T09:00:00.000Z" };
  let putBody = null;

  const fetchMock = vi.fn((url, options = {}) => {
    if (url === "/api/settings") return jsonResponse({ documentDefaults: { commonSystems: [], documentTypes: [] } });
    if (url === "/api/documents" && !options.method) return jsonResponse({ documents: [baseDocument], total: 1 });
    if (url === "/api/documents/5" && options.method === "PUT") {
      putBody = JSON.parse(options.body);
      return jsonResponse({ document: { ...baseDocument, isBookmarked: true, tags: ["rotors", "pads"] } });
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<MemoryRouter initialEntries={["/documents"]}><DocumentsPage /></MemoryRouter>);

  fireEvent.click(await screen.findByRole("button", { name: "Edit details" }));

  // Both the upload and edit forms expose a Bookmark checkbox and a Tags field;
  // the edit form's controls are last in the DOM.
  const bookmarkCheckboxes = screen.getAllByLabelText("Bookmark this document");
  fireEvent.click(bookmarkCheckboxes[bookmarkCheckboxes.length - 1]);
  const tagsInputs = screen.getAllByPlaceholderText("Comma separated, e.g. brakes, torque-specs, diy");
  fireEvent.change(tagsInputs[tagsInputs.length - 1], {
    target: { value: "rotors, pads" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save details" }));

  await waitFor(() => {
    expect(putBody).toMatchObject({ isBookmarked: true, tags: "rotors, pads" });
  });
  await waitFor(() => {
    expect(screen.getAllByText("#rotors").length).toBeGreaterThan(0);
  });
});

test("DocumentsPage sends the bookmark flag when uploading a document", async () => {
  let uploadBody = null;

  const fetchMock = vi.fn((url, options = {}) => {
    if (url === "/api/settings") return jsonResponse({ documentDefaults: { commonSystems: [], documentTypes: [] } });
    if (url === "/api/documents" && !options.method) return jsonResponse({ documents: [], total: 0 });
    if (url === "/api/documents/upload" && options.method === "POST") {
      uploadBody = options.body;
      return jsonResponse({ document: { id: 12, title: "Brake Manual", extractionStatus: "completed" } });
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<MemoryRouter initialEntries={["/documents"]}><DocumentsPage /></MemoryRouter>);

  // The upload panel is collapsed by default; open it before filling fields.
  // The panel heading and its submit button share the "Upload PDF" wording, so
  // the toggle is addressed by its expanded state rather than by name alone.
  fireEvent.click(await screen.findByRole("button", { name: /Upload PDF/i, expanded: false }));

  const fileInput = await screen.findByLabelText(/PDF file/);
  fireEvent.change(fileInput, {
    target: { files: [new File(["%PDF-1.4"], "brake.pdf", { type: "application/pdf" })] },
  });
  expect(screen.getByText("brake.pdf")).toBeInTheDocument();
  // Query upload fields by placeholder: the filter bar reuses "System"/"Document type" labels.
  fireEvent.change(screen.getByPlaceholderText("Engine, Brakes, Electrical..."), {
    target: { value: "Brakes" },
  });
  fireEvent.change(screen.getByPlaceholderText("Repair Manual, Wiring Diagram..."), {
    target: { value: "Reference" },
  });
  // With no documents loaded, the upload form is the only Bookmark checkbox on the page.
  fireEvent.click(screen.getByLabelText("Bookmark this document"));

  // Submit the form directly so jsdom's required-field validation gate doesn't block it.
  const uploadButton = screen.getByRole("button", { name: "Upload PDF" });
  fireEvent.submit(uploadButton.closest("form"));

  await waitFor(() => {
    expect(uploadBody).toBeInstanceOf(FormData);
  });
  expect(uploadBody.get("isBookmarked")).toBe("true");
});

test("DocumentsPage confirms before deleting and removes document after success", async () => {
  const firstPayload = { documents: [{ id: 9, title: "Bad Import", originalFilename: "bad.pdf", storedFilename: "bad.pdf", system: "Engine", subsystem: "", documentType: "Reference", source: "", notes: "", extractionStatus: "completed", pageCount: 1, isFavorite: false, createdAt: "2026-04-15T10:00:00.000Z", updatedAt: "2026-04-17T09:00:00.000Z" }], total: 1 };
  const secondPayload = { documents: [], total: 0 };
  let docsCalls = 0;

  const fetchMock = vi.fn((url, options) => {
    if (url === "/api/settings") return jsonResponse({ documentDefaults: { commonSystems: [], documentTypes: [] } });
    if (url === "/api/documents" && (!options || !options.method)) {
      docsCalls += 1;
      return jsonResponse(docsCalls === 1 ? firstPayload : secondPayload);
    }
    if (url === "/api/documents/9" && options?.method === "DELETE") {
      return jsonResponse({ message: "Document deleted." });
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("confirm", vi.fn(() => true));

  render(<MemoryRouter initialEntries={["/documents"]}><DocumentsPage /></MemoryRouter>);

  const deleteButton = await screen.findByRole("button", { name: "Delete document" });
  fireEvent.click(deleteButton);

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith("/api/documents/9", { method: "DELETE" });
  });
  // The library is empty now, so the list offers the upload path rather than
  // blaming filters that are not set.
  await waitFor(() => {
    expect(screen.getByText("No documents yet.")).toBeInTheDocument();
  });
  expect(
    screen.getByText("Upload your first PDF above to start your library.")
  ).toBeInTheDocument();
});


test("DocumentsPage allows re-running extraction from document details", async () => {
  const fetchMock = vi.fn((url, options = {}) => {
    if (url === "/api/documents") {
      return jsonResponse({
        documents: [
          {
            id: 1,
            title: "Sample Maintenance Schedule",
            originalFilename: "sample.pdf",
            storedFilename: "sample-copy.pdf",
            system: "Engine",
            subsystem: "Routine Service",
            documentType: "Maintenance Schedule",
            source: "Seed Data",
            notes: "Sample note",
            extractionStatus: "failed: test",
            pageCount: null,
            isFavorite: false,
            createdAt: "2026-04-15T10:00:00.000Z",
            updatedAt: "2026-04-17T09:00:00.000Z",
          },
        ],
        total: 1,
      });
    }

    if (url === "/api/settings") {
      return jsonResponse({
        documentDefaults: {
          commonSystems: ["Engine"],
          documentTypes: ["Maintenance Schedule"],
        },
      });
    }

    if (url === "/api/documents/1/extract" && options.method === "POST") {
      return jsonResponse({
        message: "Extraction re-run complete.",
        document: {
          id: 1,
          title: "Sample Maintenance Schedule",
          originalFilename: "sample.pdf",
          storedFilename: "sample-copy.pdf",
          system: "Engine",
          subsystem: "Routine Service",
          documentType: "Maintenance Schedule",
          source: "Seed Data",
          notes: "Sample note",
          extractionStatus: "completed",
          pageCount: 2,
          isFavorite: false,
          createdAt: "2026-04-15T10:00:00.000Z",
          updatedAt: "2026-04-17T09:05:00.000Z",
        },
      });
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/documents"]}>
      <DocumentsPage />
    </MemoryRouter>
  );

  const rerunButton = await screen.findByRole("button", { name: "Re-run extraction" });
  fireEvent.click(rerunButton);

  expect(await screen.findByText("Extraction re-run complete. Status: Completed.")).toBeInTheDocument();
});

// --- Copy contract ---------------------------------------------------------
//
// These pin the vocabulary the Copy Sweep settled on. They assert the *visible*
// wording, and that the relabelled controls still reach the same routes -- a
// label change that quietly moved a handler would pass a string check alone.

function buildDocument(index) {
  return {
    id: index,
    title: `Document ${index}`,
    originalFilename: `doc-${index}.pdf`,
    storedFilename: `doc-${index}-copy.pdf`,
    system: "Engine",
    subsystem: "",
    documentType: "Reference",
    source: "",
    notes: "",
    extractionStatus: "completed",
    pageCount: 1,
    isFavorite: false,
    isBookmarked: false,
    tags: [],
    createdAt: "2026-04-15T10:00:00.000Z",
    updatedAt: `2026-04-17T09:00:${String(index % 60).padStart(2, "0")}.000Z`,
  };
}

function mockDocumentsLibrary(count) {
  const documents = Array.from({ length: count }, (_, index) => buildDocument(index + 1));

  const fetchMock = vi.fn((url, options = {}) => {
    if (url === "/api/settings") {
      return jsonResponse({ documentDefaults: { commonSystems: [], documentTypes: [] } });
    }
    if (url === "/api/documents" && !options.method) {
      return jsonResponse({ documents, total: documents.length });
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

test("the document action is worded Edit details, not Edit metadata", async () => {
  let putBody = null;
  const baseDocument = buildDocument(3);

  const fetchMock = vi.fn((url, options = {}) => {
    if (url === "/api/settings") {
      return jsonResponse({ documentDefaults: { commonSystems: [], documentTypes: [] } });
    }
    if (url === "/api/documents" && !options.method) {
      return jsonResponse({ documents: [baseDocument], total: 1 });
    }
    if (url === "/api/documents/3" && options.method === "PUT") {
      putBody = JSON.parse(options.body);
      return jsonResponse({ document: { ...baseDocument, title: "Renamed" } });
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<MemoryRouter initialEntries={["/documents"]}><DocumentsPage /></MemoryRouter>);

  expect(await screen.findByRole("button", { name: "Edit details" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Edit metadata" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Edit details" }));

  expect(screen.getByRole("button", { name: "Save details" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save metadata" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Save details" }));

  // Same endpoint, same payload field names: only the button moved.
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith("/api/documents/3", expect.objectContaining({ method: "PUT" }));
  });
  expect(putBody).toHaveProperty("documentType");
  expect(await screen.findByText("Details saved.")).toBeInTheDocument();
});

test("the document action for adding a PDF is worded Upload, not Import", async () => {
  mockDocumentsLibrary(1);

  render(<MemoryRouter initialEntries={["/documents"]}><DocumentsPage /></MemoryRouter>);

  // The panel heading and its submit button use the one canonical verb.
  const toggle = await screen.findByRole("button", { name: /Upload PDF/i, expanded: false });
  expect(toggle).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Import PDF/i })).not.toBeInTheDocument();

  fireEvent.click(toggle);

  expect(screen.getByRole("button", { name: "Upload PDF" })).toBeInTheDocument();
  // "Choose PDF" survives on purpose: picking a file off disk is a different
  // action from uploading it, so it keeps its own verb.
  expect(screen.getByText("Choose PDF")).toBeInTheDocument();
});

test("the documents counter uses the one range format, page by page", async () => {
  mockDocumentsLibrary(33);

  const { unmount } = render(
    <MemoryRouter initialEntries={["/documents"]}><DocumentsPage /></MemoryRouter>
  );

  expect(await screen.findByText("Showing 1–25 of 33 documents.")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Next" }));

  // The final page stops at the total rather than at the page size.
  expect(await screen.findByText("Showing 26–33 of 33 documents.")).toBeInTheDocument();
  expect(screen.queryByText(/Showing 26–50/)).not.toBeInTheDocument();

  unmount();
});

test("the documents counter keeps singular grammar and separates thousands", async () => {
  mockDocumentsLibrary(1);

  const { unmount } = render(
    <MemoryRouter initialEntries={["/documents"]}><DocumentsPage /></MemoryRouter>
  );

  expect(await screen.findByText("Showing 1–1 of 1 document.")).toBeInTheDocument();
  unmount();

  vi.unstubAllGlobals();
  mockDocumentsLibrary(1443);

  render(<MemoryRouter initialEntries={["/documents"]}><DocumentsPage /></MemoryRouter>);

  expect(await screen.findByText("Showing 1–25 of 1,443 documents.")).toBeInTheDocument();
});

test("an empty library never renders an impossible range", async () => {
  mockDocumentsLibrary(0);

  render(<MemoryRouter initialEntries={["/documents"]}><DocumentsPage /></MemoryRouter>);

  expect(
    await screen.findByText("No documents in your library yet.")
  ).toBeInTheDocument();
  expect(screen.queryByText(/Showing 1–0/)).not.toBeInTheDocument();
  expect(screen.queryByText(/of 0 documents/)).not.toBeInTheDocument();

  // The empty state points at the upload panel, which really is on this page.
  expect(
    screen.getByText("Upload your first PDF above to start your library.")
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Upload PDF/i })).toBeInTheDocument();
});
