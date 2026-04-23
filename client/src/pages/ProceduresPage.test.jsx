import { fireEvent, render, screen } from "@testing-library/react";
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

test("ProceduresPage supports search, filters, and filtered count in the list area", async () => {
  const proceduresPayload = {
    procedures: [
      {
        id: 31,
        title: "Throttle body cleaning",
        system: "Engine",
        difficulty: "beginner",
        toolsNeeded: "Socket set",
        partsNeeded: "",
        safetyNotes: "",
        steps: "Clean throttle plate.",
        notes: "",
        confidence: "medium",
        createdAt: "2026-04-18T10:00:00.000Z",
        updatedAt: "2026-04-18T12:00:00.000Z",
        linkedDocumentIds: [],
        linkedDocuments: [],
      },
      {
        id: 32,
        title: "Rear brake pad replacement",
        system: "Brakes",
        difficulty: "advanced",
        toolsNeeded: "Caliper tool",
        partsNeeded: "Brake pads",
        safetyNotes: "",
        steps: "Service rear brakes.",
        notes: "",
        confidence: "high",
        createdAt: "2026-04-19T10:00:00.000Z",
        updatedAt: "2026-04-19T12:00:00.000Z",
        linkedDocumentIds: [],
        linkedDocuments: [],
      },
    ],
    total: 2,
  };

  const documentsPayload = {
    documents: [],
    total: 0,
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

  expect(await screen.findByPlaceholderText("Search title, system, tools, parts, steps, or notes")).toBeInTheDocument();

  fireEvent.change(screen.getByPlaceholderText("Search title, system, tools, parts, steps, or notes"), {
    target: { value: "brake" },
  });

  expect(screen.getAllByText("Rear brake pad replacement").length).toBeGreaterThan(0);
  expect(screen.queryAllByText("Throttle body cleaning")).toHaveLength(0);

  fireEvent.change(screen.getByLabelText("Difficulty filter"), {
    target: { value: "beginner" },
  });

  expect(await screen.findByText("No procedures match the current filters.")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(await screen.findByText("Throttle body cleaning")).toBeInTheDocument();
});

test("ProceduresPage keeps the detail panel on a visible procedure when filters hide the current selection", async () => {
  const proceduresPayload = {
    procedures: [
      {
        id: 31,
        title: "Throttle body cleaning",
        system: "Engine",
        difficulty: "beginner",
        toolsNeeded: "Socket set",
        partsNeeded: "",
        safetyNotes: "",
        steps: "Clean throttle plate.",
        notes: "",
        confidence: "medium",
        createdAt: "2026-04-18T10:00:00.000Z",
        updatedAt: "2026-04-18T12:00:00.000Z",
        linkedDocumentIds: [],
        linkedDocuments: [],
      },
      {
        id: 32,
        title: "Rear brake pad replacement",
        system: "Brakes",
        difficulty: "advanced",
        toolsNeeded: "Caliper tool",
        partsNeeded: "Brake pads",
        safetyNotes: "",
        steps: "Service rear brakes.",
        notes: "",
        confidence: "high",
        createdAt: "2026-04-19T10:00:00.000Z",
        updatedAt: "2026-04-19T12:00:00.000Z",
        linkedDocumentIds: [],
        linkedDocuments: [],
      },
    ],
    total: 2,
  };

  const documentsPayload = {
    documents: [],
    total: 0,
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

  expect(
    await screen.findByRole("heading", { name: "Throttle body cleaning" })
  ).toBeInTheDocument();

  fireEvent.click(screen.getByText("Rear brake pad replacement"));

  expect(
    await screen.findByRole("heading", { name: "Rear brake pad replacement" })
  ).toBeInTheDocument();

  fireEvent.change(
    screen.getByPlaceholderText("Search title, system, tools, parts, steps, or notes"),
    {
      target: { value: "throttle" },
    }
  );

  expect(
    await screen.findByRole("heading", { name: "Throttle body cleaning" })
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Rear brake pad replacement" })
  ).not.toBeInTheDocument();
});
