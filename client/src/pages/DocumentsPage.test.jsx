import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { DocumentsPage } from "./DocumentsPage";

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

test("DocumentsPage explains that favorites are the only saved-document flag in V1", async () => {
  const fetchMock = vi.fn((url) => {
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
            extractionStatus: "completed",
            pageCount: 1,
            isFavorite: true,
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

    throw new Error(`Unexpected fetch call: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/documents"]}>
      <DocumentsPage />
    </MemoryRouter>
  );

  expect(
    await screen.findByText("Favorites are the only saved-document flag in V1.")
  ).toBeInTheDocument();
  expect(
    screen.getByText("Tags and bookmarks are not part of the current document workflow.")
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
