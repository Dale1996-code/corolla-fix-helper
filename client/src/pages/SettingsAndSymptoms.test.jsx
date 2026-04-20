import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";
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

test("SettingsPage loads settings and saves vehicle changes", async () => {
  const initialSettings = {
    vehicle: {
      id: 1,
      year: 2009,
      make: "Toyota",
      model: "Corolla",
      trim: "LE",
      engine: "1.8L",
    },
    runtime: {
      databaseFile: "C:/temp/corolla.db",
      uploadsDir: "C:/temp/uploads",
      maxUploadSizeMb: 20,
      port: 4000,
      clientPort: 5173,
      pathsEditable: false,
    },
    documentDefaults: {
      commonSystems: ["Engine", "Brakes", "Electrical"],
      documentTypes: ["Repair Manual", "Wiring Diagram", "Inspection"],
    },
    backupExport: {
      supported: false,
      path: "",
      message: "Backup and export are not wired up yet.",
    },
  };

  const fetchMock = vi.fn((url, options = {}) => {
    if (url === "/api/settings") {
      return jsonResponse(initialSettings);
    }

    if (url === "/api/settings/vehicle" && options.method === "PUT") {
      const body = JSON.parse(options.body);

      return jsonResponse({
        message: "Vehicle settings updated.",
        vehicle: {
          id: 1,
          year: Number(body.year),
          make: body.make,
          model: body.model,
          trim: body.trim,
          engine: body.engine,
        },
      });
    }

    if (url === "/api/settings/document-defaults" && options.method === "PUT") {
      const body = JSON.parse(options.body);

      return jsonResponse({
        message: "Document defaults updated.",
        documentDefaults: {
          commonSystems: body.commonSystems,
          documentTypes: body.documentTypes,
        },
      });
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(<SettingsPage />);

  expect(await screen.findByDisplayValue("2009")).toBeInTheDocument();
  expect(screen.getByText("Database file")).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Trim"), {
    target: {
      value: "S",
    },
  });

  fireEvent.click(screen.getByRole("button", { name: "Save vehicle profile" }));

  expect(await screen.findByText("Vehicle profile saved.")).toBeInTheDocument();

  const saveCall = fetchMock.mock.calls.find(
    ([url, options]) => url === "/api/settings/vehicle" && options?.method === "PUT"
  );

  expect(saveCall).toBeTruthy();
  expect(JSON.parse(saveCall[1].body)).toMatchObject({
    year: "2009",
    make: "Toyota",
    model: "Corolla",
    trim: "S",
    engine: "1.8L",
  });

  fireEvent.change(screen.getByLabelText(/Common system names/i), {
    target: {
      value: "Engine\nCooling\nElectrical",
    },
  });

  fireEvent.click(screen.getByRole("button", { name: "Save document defaults" }));

  expect(await screen.findByText("Document defaults saved.")).toBeInTheDocument();

  const defaultsSaveCall = fetchMock.mock.calls.find(
    ([url, options]) =>
      url === "/api/settings/document-defaults" && options?.method === "PUT"
  );

  expect(defaultsSaveCall).toBeTruthy();
  expect(JSON.parse(defaultsSaveCall[1].body)).toMatchObject({
    commonSystems: ["Engine", "Cooling", "Electrical"],
    documentTypes: ["Repair Manual", "Wiring Diagram", "Inspection"],
  });
});

test("SymptomsPage supports search, filters, sorting, and empty filtered states", async () => {
  const symptomsPayload = {
    symptoms: [
      {
        id: 1,
        title: "Brake squeal during cold start",
        description: "Squeals for the first minute of driving.",
        system: "Brakes",
        suspectedCauses: "Glazed pads",
        confidence: "medium",
        status: "open",
        notes: "Most noticeable after rain.",
        createdAt: "2026-04-15T10:00:00.000Z",
        updatedAt: "2026-04-17T09:00:00.000Z",
        linkedDocumentIds: [11],
        linkedDocuments: [
          {
            id: 11,
            title: "Brake inspection notes",
            system: "Brakes",
            documentType: "Inspection",
          },
        ],
      },
      {
        id: 2,
        title: "Engine hesitation under load",
        description: "Hesitates while merging uphill.",
        system: "Engine",
        suspectedCauses: "Fuel delivery issue",
        confidence: "high",
        status: "monitoring",
        notes: "Gets worse uphill.",
        createdAt: "2026-04-14T09:00:00.000Z",
        updatedAt: "2026-04-16T08:00:00.000Z",
        linkedDocumentIds: [12],
        linkedDocuments: [],
      },
      {
        id: 3,
        title: "Cabin rattle near glove box",
        description: "Light buzz over rough pavement.",
        system: "Interior",
        suspectedCauses: "Loose trim clip",
        confidence: "low",
        status: "resolved",
        notes: "Stopped after adding felt tape.",
        createdAt: "2026-04-13T07:00:00.000Z",
        updatedAt: "2026-04-15T06:00:00.000Z",
        linkedDocumentIds: [],
        linkedDocuments: [],
      },
    ],
    total: 3,
  };

  const documentsPayload = {
    documents: [
      {
        id: 11,
        title: "Brake inspection notes",
        system: "Brakes",
        documentType: "Inspection",
      },
      {
        id: 12,
        title: "Fuel system test steps",
        system: "Engine",
        documentType: "Procedure",
      },
    ],
    total: 2,
  };

  const fetchMock = vi.fn((url) => {
    if (url === "/api/symptoms") {
      return jsonResponse(symptomsPayload);
    }

    if (url === "/api/documents") {
      return jsonResponse(documentsPayload);
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/symptoms"]}>
      <SymptomsPage />
    </MemoryRouter>
  );

  const getRowTitles = () =>
    screen.queryAllByTestId("symptom-row-title").map((node) => node.textContent);

  expect(
    await screen.findByRole("heading", { name: "Brake squeal during cold start" })
  ).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "Open document Brake inspection notes" })
  ).toHaveAttribute("href", "/documents?documentId=11#document-library");

  await waitFor(() => {
    expect(getRowTitles()).toEqual([
      "Brake squeal during cold start",
      "Engine hesitation under load",
      "Cabin rattle near glove box",
    ]);
  });

  fireEvent.change(screen.getByLabelText("Sort order"), {
    target: {
      value: "title",
    },
  });

  await waitFor(() => {
    expect(getRowTitles()).toEqual([
      "Brake squeal during cold start",
      "Cabin rattle near glove box",
      "Engine hesitation under load",
    ]);
  });

  fireEvent.change(screen.getByLabelText("System filter"), {
    target: {
      value: "Engine",
    },
  });

  expect(
    await screen.findByRole("heading", { name: "Engine hesitation under load" })
  ).toBeInTheDocument();

  await waitFor(() => {
    expect(getRowTitles()).toEqual(["Engine hesitation under load"]);
  });

  fireEvent.change(screen.getByLabelText("System filter"), {
    target: {
      value: "all",
    },
  });

  fireEvent.change(screen.getByLabelText("Search"), {
    target: {
      value: "uphill",
    },
  });

  expect(
    await screen.findByRole("heading", { name: "Engine hesitation under load" })
  ).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Status filter"), {
    target: {
      value: "resolved",
    },
  });

  expect(
    await screen.findByText("No symptoms match the current filters.")
  ).toBeInTheDocument();
  expect(screen.getByText("Select a symptom to view details.")).toBeInTheDocument();
});

test("SymptomsPage helps narrow to active and high-confidence symptoms, then clear filters", async () => {
  const symptomsPayload = {
    symptoms: [
      {
        id: 1,
        title: "Brake squeal during cold start",
        description: "Squeals for the first minute of driving.",
        system: "Brakes",
        suspectedCauses: "Glazed pads",
        confidence: "medium",
        status: "open",
        notes: "Most noticeable after rain.",
        createdAt: "2026-04-15T10:00:00.000Z",
        updatedAt: "2026-04-17T09:00:00.000Z",
        linkedDocumentIds: [11],
        linkedDocuments: [],
      },
      {
        id: 2,
        title: "Engine hesitation under load",
        description: "Hesitates while merging uphill.",
        system: "Engine",
        suspectedCauses: "Fuel delivery issue",
        confidence: "high",
        status: "monitoring",
        notes: "Gets worse uphill.",
        createdAt: "2026-04-14T09:00:00.000Z",
        updatedAt: "2026-04-16T08:00:00.000Z",
        linkedDocumentIds: [12],
        linkedDocuments: [],
      },
      {
        id: 3,
        title: "Cabin rattle near glove box",
        description: "Light buzz over rough pavement.",
        system: "Interior",
        suspectedCauses: "Loose trim clip",
        confidence: "low",
        status: "resolved",
        notes: "Stopped after adding felt tape.",
        createdAt: "2026-04-13T07:00:00.000Z",
        updatedAt: "2026-04-15T06:00:00.000Z",
        linkedDocumentIds: [],
        linkedDocuments: [],
      },
    ],
    total: 3,
  };

  const documentsPayload = {
    documents: [
      {
        id: 11,
        title: "Brake inspection notes",
        system: "Brakes",
        documentType: "Inspection",
      },
      {
        id: 12,
        title: "Fuel system test steps",
        system: "Engine",
        documentType: "Procedure",
      },
    ],
    total: 2,
  };

  const fetchMock = vi.fn((url) => {
    if (url === "/api/symptoms") {
      return jsonResponse(symptomsPayload);
    }

    if (url === "/api/documents") {
      return jsonResponse(documentsPayload);
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/symptoms"]}>
      <SymptomsPage />
    </MemoryRouter>
  );

  const getRowTitles = () =>
    screen.queryAllByTestId("symptom-row-title").map((node) => node.textContent);

  expect(
    await screen.findByRole("heading", { name: "Brake squeal during cold start" })
  ).toBeInTheDocument();
  expect(screen.getByText("Showing all 3 symptoms")).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Status filter"), {
    target: {
      value: "active",
    },
  });

  await waitFor(() => {
    expect(getRowTitles()).toEqual([
      "Brake squeal during cold start",
      "Engine hesitation under load",
    ]);
  });
  expect(screen.getByText("Showing 2 of 3 symptoms")).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Confidence filter"), {
    target: {
      value: "high",
    },
  });

  await waitFor(() => {
    expect(getRowTitles()).toEqual(["Engine hesitation under load"]);
  });
  expect(screen.getByText("Showing 1 of 3 symptoms")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

  await waitFor(() => {
    expect(getRowTitles()).toEqual([
      "Brake squeal during cold start",
      "Engine hesitation under load",
      "Cabin rattle near glove box",
    ]);
  });
  expect(screen.getByText("Showing all 3 symptoms")).toBeInTheDocument();
});
