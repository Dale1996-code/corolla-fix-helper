import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { SymptomsPage } from "./SymptomsPage";

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

function baseSymptom(overrides = {}) {
  return {
    id: 1,
    title: "Rough idle at stoplights",
    description: "Idle surges then nearly stalls.",
    system: "Engine",
    suspectedCauses: "dirty throttle body",
    confidence: "medium",
    status: "open",
    notes: "",
    createdAt: "2026-04-18T10:00:00.000Z",
    updatedAt: "2026-04-18T12:00:00.000Z",
    linkedDocumentIds: [],
    linkedDocuments: [],
    linkedProcedureIds: [31],
    linkedProcedures: [
      { id: 31, title: "Clean the throttle body", system: "Engine", difficulty: "beginner" },
    ],
    ...overrides,
  };
}

const proceduresPayload = {
  procedures: [
    { id: 31, title: "Clean the throttle body", system: "Engine", difficulty: "beginner" },
    { id: 32, title: "Replace spark plugs", system: "Engine", difficulty: "intermediate" },
  ],
  total: 2,
};

const settingsPayload = {
  documentDefaults: { commonSystems: ["Engine"], documentTypes: [] },
};

test("symptom detail renders linked procedures and the link selector", async () => {
  const fetchMock = vi.fn((url) => {
    if (url === "/api/symptoms") {
      return jsonResponse({ symptoms: [baseSymptom()], total: 1 });
    }
    if (url === "/api/documents") {
      return jsonResponse({ documents: [], total: 0 });
    }
    if (url === "/api/procedures") {
      return jsonResponse(proceduresPayload);
    }
    if (url === "/api/settings") {
      return jsonResponse(settingsPayload);
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/symptoms"]}>
      <SymptomsPage />
    </MemoryRouter>
  );

  expect(
    await screen.findByRole("heading", { name: "Rough idle at stoplights" })
  ).toBeInTheDocument();

  // Linked procedure shows in the detail panel as a clickable row.
  expect(
    await screen.findByRole("link", { name: "Open procedure Clean the throttle body" })
  ).toHaveAttribute("href", "/procedures?procedureId=31#procedure-library");

  // The link selector lists every procedure with a checkbox.
  expect(screen.getByRole("checkbox", { name: /Replace spark plugs/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save linked procedures" })).toBeInTheDocument();
});

test("user can save linked procedures with mocked fetch", async () => {
  const fetchMock = vi.fn((url, options = {}) => {
    if (url === "/api/symptoms") {
      return jsonResponse({ symptoms: [baseSymptom()], total: 1 });
    }
    if (url === "/api/documents") {
      return jsonResponse({ documents: [], total: 0 });
    }
    if (url === "/api/procedures") {
      return jsonResponse(proceduresPayload);
    }
    if (url === "/api/settings") {
      return jsonResponse(settingsPayload);
    }
    if (url === "/api/symptoms/1/procedures" && options.method === "PUT") {
      return jsonResponse({
        message: "Linked procedures updated.",
        symptom: baseSymptom({
          linkedProcedureIds: [31, 32],
          linkedProcedures: [
            { id: 31, title: "Clean the throttle body", system: "Engine", difficulty: "beginner" },
            { id: 32, title: "Replace spark plugs", system: "Engine", difficulty: "intermediate" },
          ],
        }),
      });
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/symptoms"]}>
      <SymptomsPage />
    </MemoryRouter>
  );

  fireEvent.click(await screen.findByRole("checkbox", { name: /Replace spark plugs/i }));
  fireEvent.click(screen.getByRole("button", { name: "Save linked procedures" }));

  expect(await screen.findByText("Linked procedures saved.")).toBeInTheDocument();

  const putCall = fetchMock.mock.calls.find(
    ([url, options]) => url === "/api/symptoms/1/procedures" && options?.method === "PUT"
  );

  expect(putCall).toBeTruthy();
  expect(JSON.parse(putCall[1].body)).toEqual({ procedureIds: [31, 32] });
});

test("suggested procedures render with reasons and citations and can be linked", async () => {
  const suggestionsPayload = {
    symptomId: 1,
    status: "answered",
    mode: "deterministic",
    aiConfigured: false,
    query: "Rough idle",
    suggestions: [
      {
        procedureId: 32,
        title: "Replace spark plugs",
        system: "Engine",
        difficulty: "intermediate",
        reason: "Same system (Engine); shares terms: idle, misfire.",
        source: "keyword",
        citations: [
          {
            documentId: 7,
            documentTitle: "Ignition service",
            pageNumber: 4,
            snippet: "Worn spark plugs can cause rough idle and misfire.",
          },
        ],
      },
    ],
    citations: [],
  };

  const fetchMock = vi.fn((url, options = {}) => {
    if (url === "/api/symptoms") {
      return jsonResponse({ symptoms: [baseSymptom()], total: 1 });
    }
    if (url === "/api/documents") {
      return jsonResponse({ documents: [], total: 0 });
    }
    if (url === "/api/procedures") {
      return jsonResponse(proceduresPayload);
    }
    if (url === "/api/settings") {
      return jsonResponse(settingsPayload);
    }
    if (url === "/api/symptoms/1/suggested-procedures") {
      return jsonResponse(suggestionsPayload);
    }
    if (url === "/api/symptoms/1/procedures" && options.method === "PUT") {
      return jsonResponse({
        message: "Linked procedures updated.",
        symptom: baseSymptom({
          linkedProcedureIds: [31, 32],
          linkedProcedures: [
            { id: 31, title: "Clean the throttle body", system: "Engine", difficulty: "beginner" },
            { id: 32, title: "Replace spark plugs", system: "Engine", difficulty: "intermediate" },
          ],
        }),
      });
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/symptoms"]}>
      <SymptomsPage />
    </MemoryRouter>
  );

  fireEvent.click(await screen.findByRole("button", { name: "Suggest fixes" }));

  // Ranked suggestion shows the procedure, the reason, and a citation.
  expect(
    await screen.findByText("Same system (Engine); shares terms: idle, misfire.")
  ).toBeInTheDocument();
  expect(screen.getByText(/Ignition service, page 4/)).toBeInTheDocument();
  expect(
    screen.getByText("Worn spark plugs can cause rough idle and misfire.")
  ).toBeInTheDocument();

  // Linking the suggestion calls the manual-link route with the new id added.
  fireEvent.click(screen.getByRole("button", { name: "Link" }));

  await waitFor(() => {
    const putCall = fetchMock.mock.calls.find(
      ([url, options]) => url === "/api/symptoms/1/procedures" && options?.method === "PUT"
    );
    expect(putCall).toBeTruthy();
    expect(JSON.parse(putCall[1].body)).toEqual({ procedureIds: [31, 32] });
  });
});
