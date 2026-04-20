import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { ProceduresPage } from "./ProceduresPage";

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

test("ProceduresPage shows clickable linked documents in the detail panel", async () => {
  const proceduresPayload = {
    procedures: [
      {
        id: 31,
        title: "Throttle body cleaning",
        system: "Engine",
        difficulty: "beginner",
        toolsNeeded: "",
        partsNeeded: "",
        safetyNotes: "",
        steps: "Remove intake tube and clean the throttle plate.",
        notes: "",
        confidence: "medium",
        createdAt: "2026-04-18T10:00:00.000Z",
        updatedAt: "2026-04-18T12:00:00.000Z",
        linkedDocumentIds: [11],
        linkedDocuments: [
          {
            id: 11,
            title: "Throttle body reference",
            system: "Engine",
            documentType: "Reference",
          },
        ],
      },
    ],
    total: 1,
  };

  const documentsPayload = {
    documents: [
      {
        id: 11,
        title: "Throttle body reference",
        system: "Engine",
        documentType: "Reference",
      },
    ],
    total: 1,
  };

  const fetchMock = vi.fn((url) => {
    if (url === "/api/procedures") {
      return jsonResponse(proceduresPayload);
    }

    if (url === "/api/documents") {
      return jsonResponse(documentsPayload);
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/procedures"]}>
      <ProceduresPage />
    </MemoryRouter>
  );

  expect(await screen.findByRole("heading", { name: "Throttle body cleaning" })).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "Open document Throttle body reference" })
  ).toHaveAttribute("href", "/documents?documentId=11#document-library");
});
