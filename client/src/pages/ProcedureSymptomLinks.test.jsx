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

function baseProcedure(overrides = {}) {
  return {
    id: 31,
    title: "Clean the throttle body",
    system: "Engine",
    difficulty: "beginner",
    toolsNeeded: "",
    partsNeeded: "",
    safetyNotes: "",
    steps: "Remove intake and clean the throttle plate.",
    notes: "",
    confidence: "medium",
    createdAt: "2026-04-18T10:00:00.000Z",
    updatedAt: "2026-04-18T12:00:00.000Z",
    linkedDocumentIds: [],
    linkedDocuments: [],
    linkedSymptomIds: [5],
    linkedSymptoms: [{ id: 5, title: "Rough idle", system: "Engine", status: "open" }],
    ...overrides,
  };
}

const symptomsPayload = {
  symptoms: [
    { id: 5, title: "Rough idle", system: "Engine", status: "open" },
    { id: 6, title: "Stalls when cold", system: "Engine", status: "monitoring" },
  ],
  total: 2,
};

test("procedure detail renders linked symptoms and the link selector", async () => {
  const fetchMock = vi.fn((url) => {
    if (url === "/api/procedures") {
      return jsonResponse({ procedures: [baseProcedure()], total: 1 });
    }
    if (url === "/api/documents") {
      return jsonResponse({ documents: [], total: 0 });
    }
    if (url === "/api/symptoms") {
      return jsonResponse(symptomsPayload);
    }
    if (url === "/api/settings") {
      return jsonResponse({ documentDefaults: { commonSystems: [], documentTypes: [] } });
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
    await screen.findByRole("heading", { name: "Clean the throttle body" })
  ).toBeInTheDocument();

  expect(
    await screen.findByRole("link", { name: "Open symptom Rough idle" })
  ).toHaveAttribute("href", "/symptoms?symptomId=5#symptom-library");

  expect(screen.getByRole("checkbox", { name: /Stalls when cold/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save linked symptoms" })).toBeInTheDocument();
});

test("user can save linked symptoms with mocked fetch", async () => {
  const fetchMock = vi.fn((url, options = {}) => {
    if (url === "/api/procedures") {
      return jsonResponse({ procedures: [baseProcedure()], total: 1 });
    }
    if (url === "/api/documents") {
      return jsonResponse({ documents: [], total: 0 });
    }
    if (url === "/api/symptoms") {
      return jsonResponse(symptomsPayload);
    }
    if (url === "/api/settings") {
      return jsonResponse({ documentDefaults: { commonSystems: [], documentTypes: [] } });
    }
    if (url === "/api/procedures/31/symptoms" && options.method === "PUT") {
      return jsonResponse({
        message: "Linked symptoms updated.",
        procedure: baseProcedure({
          linkedSymptomIds: [5, 6],
          linkedSymptoms: [
            { id: 5, title: "Rough idle", system: "Engine", status: "open" },
            { id: 6, title: "Stalls when cold", system: "Engine", status: "monitoring" },
          ],
        }),
      });
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/procedures"]}>
      <ProceduresPage />
    </MemoryRouter>
  );

  fireEvent.click(await screen.findByRole("checkbox", { name: /Stalls when cold/i }));
  fireEvent.click(screen.getByRole("button", { name: "Save linked symptoms" }));

  expect(await screen.findByText("Linked symptoms saved.")).toBeInTheDocument();

  const putCall = fetchMock.mock.calls.find(
    ([url, options]) => url === "/api/procedures/31/symptoms" && options?.method === "PUT"
  );

  expect(putCall).toBeTruthy();
  expect(JSON.parse(putCall[1].body)).toEqual({ symptomIds: [5, 6] });
});
