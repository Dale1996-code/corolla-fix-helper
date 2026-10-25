import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { SymptomsPage } from "./SymptomsPage";
import { createSymptomsApi } from "../test/symptomsApiMock";

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

// The page searches procedures a page at a time instead of downloading them
// all, so the stand-in server answers those searches from `proceduresPayload`.
function stubSymptomsApi({ extra } = {}) {
  const api = createSymptomsApi(
    { symptoms: [baseSymptom()], procedures: proceduresPayload.procedures },
    {
      extra: (url, init, state) => {
        if (url === "/api/settings") {
          return jsonResponse(settingsPayload);
        }
        return extra?.(url, init, state);
      },
    }
  );
  const fetchMock = vi.fn(api.fetch);
  fetchMock.api = api;
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

test("symptom detail renders linked procedures and the link selector", async () => {
  stubSymptomsApi();

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

  // The link selector lists the first page of procedures with a checkbox.
  expect(
    await screen.findByRole("checkbox", { name: /Replace spark plugs/i })
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save linked procedures" })).toBeInTheDocument();
});

test("user can save linked procedures with mocked fetch", async () => {
  const fetchMock = stubSymptomsApi({
    extra: (url, options = {}) => {
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
      return undefined;
    },
  });

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

  const fetchMock = stubSymptomsApi({
    extra: (url, options = {}) => {
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
      return undefined;
    },
  });

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
