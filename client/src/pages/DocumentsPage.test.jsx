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

test("DocumentsPage saves bookmark flag and tags when editing metadata", async () => {
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

  fireEvent.click(await screen.findByRole("button", { name: "Edit metadata" }));

  // Both the upload and edit forms expose a Bookmark checkbox and a Tags field;
  // the edit form's controls are last in the DOM.
  const bookmarkCheckboxes = screen.getAllByLabelText("Bookmark this document");
  fireEvent.click(bookmarkCheckboxes[bookmarkCheckboxes.length - 1]);
  const tagsInputs = screen.getAllByPlaceholderText("Comma separated, e.g. brakes, torque-specs, diy");
  fireEvent.change(tagsInputs[tagsInputs.length - 1], {
    target: { value: "rotors, pads" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));

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

  // The import panel is collapsed by default; open it before filling fields.
  fireEvent.click(await screen.findByRole("button", { name: /Import PDF/i }));

  const fileInput = await screen.findByLabelText(/PDF file/);
  fireEvent.change(fileInput, {
    target: { files: [new File(["%PDF-1.4"], "brake.pdf", { type: "application/pdf" })] },
  });
  expect(screen.getByText("brake.pdf")).toBeInTheDocument();
  // Query upload fields by placeholder: the filter bar reuses "System"/"Document Type" labels.
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
  await waitFor(() => {
    expect(screen.getByText("No documents match these filters.")).toBeInTheDocument();
  });
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
