import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { ProceduresPage } from "./ProceduresPage";
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

test("SymptomsPage shows saved system suggestions from Settings in create and edit forms", async () => {
  const fetchMock = vi.fn((url) => {
    if (url === "/api/symptoms") {
      return jsonResponse({
        symptoms: [
          {
            id: 1,
            title: "Brake squeal during cold start",
            description: "Squeals for the first minute of driving.",
            system: "Brakes",
            suspectedCauses: "Glazed pads",
            confidence: "medium",
            status: "open",
            notes: "",
            createdAt: "2026-04-15T10:00:00.000Z",
            updatedAt: "2026-04-17T09:00:00.000Z",
            linkedDocumentIds: [],
            linkedDocuments: [],
          },
        ],
      });
    }

    if (url === "/api/documents") {
      return jsonResponse({
        documents: [
          {
            id: 11,
            title: "Brake inspection notes",
            system: "Brakes",
            documentType: "Inspection",
          },
        ],
      });
    }

    if (url === "/api/settings") {
      return jsonResponse({
        documentDefaults: {
          commonSystems: ["Engine", "Cooling"],
        },
      });
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  const { container } = render(
    <MemoryRouter initialEntries={["/symptoms"]}>
      <SymptomsPage />
    </MemoryRouter>
  );

  expect(
    await screen.findByRole("heading", { name: "Brake squeal during cold start" })
  ).toBeInTheDocument();

  await waitFor(() => {
    expect(
      container.querySelector('#create-symptom-system-suggestions option[value="Engine"]')
    ).toBeTruthy();
    expect(
      container.querySelector('#create-symptom-system-suggestions option[value="Cooling"]')
    ).toBeTruthy();
    expect(
      container.querySelector('#create-symptom-system-suggestions option[value="Brakes"]')
    ).toBeTruthy();
  });

  fireEvent.click(screen.getByRole("button", { name: "Edit symptom" }));

  expect(
    container.querySelector('#edit-symptom-system-suggestions option[value="Engine"]')
  ).toBeTruthy();
  expect(
    container.querySelector('#edit-symptom-system-suggestions option[value="Brakes"]')
  ).toBeTruthy();
});

test("ProceduresPage shows saved system suggestions from Settings in create and edit forms", async () => {
  const fetchMock = vi.fn((url) => {
    if (url === "/api/procedures") {
      return jsonResponse({
        procedures: [
          {
            id: 21,
            title: "Spark plug replacement",
            system: "Ignition",
            difficulty: "intermediate",
            toolsNeeded: "",
            partsNeeded: "",
            safetyNotes: "",
            steps: "",
            notes: "",
            confidence: "medium",
            createdAt: "2026-04-15T10:00:00.000Z",
            updatedAt: "2026-04-17T09:00:00.000Z",
            linkedDocumentIds: [],
            linkedDocuments: [],
          },
        ],
      });
    }

    if (url === "/api/documents") {
      return jsonResponse({
        documents: [
          {
            id: 11,
            title: "Tune-up notes",
            system: "Ignition",
            documentType: "Procedure",
          },
        ],
      });
    }

    if (url === "/api/settings") {
      return jsonResponse({
        documentDefaults: {
          commonSystems: ["Engine", "Cooling"],
        },
      });
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  const { container } = render(
    <MemoryRouter initialEntries={["/procedures"]}>
      <ProceduresPage />
    </MemoryRouter>
  );

  expect(
    await screen.findByRole("heading", { name: "Spark plug replacement" })
  ).toBeInTheDocument();

  await waitFor(() => {
    expect(
      container.querySelector('#create-procedure-system-suggestions option[value="Engine"]')
    ).toBeTruthy();
    expect(
      container.querySelector('#create-procedure-system-suggestions option[value="Cooling"]')
    ).toBeTruthy();
    expect(
      container.querySelector('#create-procedure-system-suggestions option[value="Ignition"]')
    ).toBeTruthy();
  });

  fireEvent.click(screen.getByRole("button", { name: "Edit procedure" }));

  expect(
    container.querySelector('#edit-procedure-system-suggestions option[value="Engine"]')
  ).toBeTruthy();
  expect(
    container.querySelector('#edit-procedure-system-suggestions option[value="Ignition"]')
  ).toBeTruthy();
});
