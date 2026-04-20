import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { NotesPage } from "./NotesPage";

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

test("NotesPage filters notes by linked item type", async () => {
  const notesPayload = {
    notes: [
      {
        id: 1,
        title: "Document note",
        content: "Linked to a document",
        noteType: "general",
        relatedEntityType: "document",
        relatedEntityId: 11,
        linkedDocument: {
          id: 11,
          title: "Ignition system overview",
          system: "Engine",
          documentType: "Reference",
        },
        linkedSymptom: null,
        linkedProcedure: null,
        createdAt: "2026-04-18T08:00:00.000Z",
        updatedAt: "2026-04-18T08:10:00.000Z",
      },
      {
        id: 2,
        title: "Symptom note",
        content: "Linked to a symptom",
        noteType: "observation",
        relatedEntityType: "symptom",
        relatedEntityId: 21,
        linkedDocument: null,
        linkedSymptom: {
          id: 21,
          title: "Rough idle at stoplight",
          system: "Engine",
          status: "monitoring",
        },
        linkedProcedure: null,
        createdAt: "2026-04-18T09:00:00.000Z",
        updatedAt: "2026-04-18T09:10:00.000Z",
      },
      {
        id: 3,
        title: "Procedure note",
        content: "Linked to a procedure",
        noteType: "repair_log",
        relatedEntityType: "procedure",
        relatedEntityId: 31,
        linkedDocument: null,
        linkedSymptom: null,
        linkedProcedure: {
          id: 31,
          title: "Spark plug replacement",
          system: "Engine",
          difficulty: "beginner",
        },
        createdAt: "2026-04-18T10:00:00.000Z",
        updatedAt: "2026-04-18T10:10:00.000Z",
      },
      {
        id: 4,
        title: "Unlinked note",
        content: "Not linked to anything",
        noteType: "reminder",
        relatedEntityType: "none",
        relatedEntityId: null,
        linkedDocument: null,
        linkedSymptom: null,
        linkedProcedure: null,
        createdAt: "2026-04-18T11:00:00.000Z",
        updatedAt: "2026-04-18T11:10:00.000Z",
      },
    ],
    total: 4,
  };

  const fetchMock = vi.fn((url) => {
    if (url === "/api/notes") {
      return jsonResponse(notesPayload);
    }

    if (url === "/api/documents") {
      return jsonResponse({ documents: [], total: 0 });
    }

    if (url === "/api/symptoms") {
      return jsonResponse({ symptoms: [], total: 0 });
    }

    if (url === "/api/procedures") {
      return jsonResponse({ procedures: [], total: 0 });
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/notes"]}>
      <NotesPage />
    </MemoryRouter>
  );

  expect((await screen.findAllByText("Document note")).length).toBeGreaterThan(0);
  expect(screen.getAllByText("Symptom note").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Procedure note").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Unlinked note").length).toBeGreaterThan(0);

  fireEvent.change(screen.getByLabelText("Linked item"), {
    target: { value: "symptom" },
  });

  expect(screen.getAllByText("Symptom note").length).toBeGreaterThan(0);
  expect(screen.queryAllByText("Document note")).toHaveLength(0);
  expect(screen.queryAllByText("Procedure note")).toHaveLength(0);
  expect(screen.queryAllByText("Unlinked note")).toHaveLength(0);
  expect(screen.getByText("1")).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Linked item"), {
    target: { value: "none" },
  });

  expect(screen.getAllByText("Unlinked note").length).toBeGreaterThan(0);
  expect(screen.queryAllByText("Document note")).toHaveLength(0);
  expect(screen.queryAllByText("Symptom note")).toHaveLength(0);
  expect(screen.queryAllByText("Procedure note")).toHaveLength(0);
});

test("NotesPage supports symptom and procedure links in create, edit, and details views", async () => {
  const notesPayload = {
    notes: [
      {
        id: 1,
        title: "Spark plug torque reminder",
        content: "Double-check the torque spec before reinstalling.",
        noteType: "reminder",
        relatedEntityType: "procedure",
        relatedEntityId: 31,
        linkedDocument: null,
        linkedSymptom: null,
        linkedProcedure: {
          id: 31,
          title: "Spark plug replacement",
          system: "Engine",
          difficulty: "beginner",
        },
        createdAt: "2026-04-16T08:00:00.000Z",
        updatedAt: "2026-04-17T09:00:00.000Z",
      },
    ],
    total: 1,
  };

  const documentsPayload = {
    documents: [
      {
        id: 11,
        title: "Ignition system overview",
        system: "Engine",
        documentType: "Reference",
      },
    ],
    total: 1,
  };

  const symptomsPayload = {
    symptoms: [
      {
        id: 21,
        title: "Rough idle at stoplight",
        system: "Engine",
        status: "monitoring",
      },
    ],
    total: 1,
  };

  const proceduresPayload = {
    procedures: [
      {
        id: 31,
        title: "Spark plug replacement",
        system: "Engine",
        difficulty: "beginner",
      },
    ],
    total: 1,
  };

  const createdNote = {
    id: 2,
    title: "Watch idle after test drive",
    content: "See if the idle drops after the next stoplight.",
    noteType: "observation",
    relatedEntityType: "symptom",
    relatedEntityId: 21,
    linkedDocument: null,
    linkedSymptom: {
      id: 21,
      title: "Rough idle at stoplight",
      system: "Engine",
      status: "monitoring",
    },
    linkedProcedure: null,
    createdAt: "2026-04-18T10:00:00.000Z",
    updatedAt: "2026-04-18T10:00:00.000Z",
  };

  const updatedNote = {
    ...createdNote,
    relatedEntityType: "procedure",
    relatedEntityId: 31,
    linkedSymptom: null,
    linkedProcedure: {
      id: 31,
      title: "Spark plug replacement",
      system: "Engine",
      difficulty: "beginner",
    },
    updatedAt: "2026-04-18T10:15:00.000Z",
  };

  const fetchMock = vi.fn((url, options = {}) => {
    if (url === "/api/notes" && (!options.method || options.method === "GET")) {
      return jsonResponse(notesPayload);
    }

    if (url === "/api/documents") {
      return jsonResponse(documentsPayload);
    }

    if (url === "/api/symptoms") {
      return jsonResponse(symptomsPayload);
    }

    if (url === "/api/procedures") {
      return jsonResponse(proceduresPayload);
    }

    if (url === "/api/notes" && options.method === "POST") {
      return jsonResponse({
        message: "Note created.",
        note: createdNote,
      });
    }

    if (url === "/api/notes/2" && options.method === "PUT") {
      return jsonResponse({
        message: "Note updated.",
        note: updatedNote,
      });
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/notes"]}>
      <NotesPage />
    </MemoryRouter>
  );

  const initialDetailsSection = (
    await screen.findByRole("heading", { name: "Spark plug torque reminder" })
  ).closest("section");
  expect(initialDetailsSection).not.toBeNull();
  const linkedItemSummary = within(initialDetailsSection)
    .getByText("Linked item")
    .closest("div");
  expect(linkedItemSummary).not.toBeNull();
  expect(within(linkedItemSummary).getByText("Spark plug replacement")).toBeInTheDocument();
  expect(within(linkedItemSummary).getByText("Procedure")).toBeInTheDocument();
  expect(
    within(linkedItemSummary).getByRole("link", { name: "Open linked procedure Spark plug replacement" })
  ).toHaveAttribute("href", "/procedures?procedureId=31#procedure-library");
  expect(screen.getByText("Engine - Beginner")).toBeInTheDocument();

  const createSection = screen.getByRole("heading", { name: "Create note" }).closest("section");
  expect(createSection).not.toBeNull();
  const createScope = within(createSection);

  fireEvent.change(createScope.getByPlaceholderText("Idle note after coil replacement"), {
    target: {
      value: "Watch idle after test drive",
    },
  });
  fireEvent.change(createScope.getAllByRole("combobox")[0], {
    target: {
      value: "observation",
    },
  });
  fireEvent.change(createScope.getAllByRole("combobox")[1], {
    target: {
      value: "symptom",
    },
  });
  fireEvent.change(createScope.getAllByRole("combobox")[2], {
    target: {
      value: "21",
    },
  });
  fireEvent.change(createScope.getByPlaceholderText("Write your note here..."), {
    target: {
      value: "See if the idle drops after the next stoplight.",
    },
  });

  fireEvent.click(createScope.getByRole("button", { name: "Save note" }));

  expect(await screen.findByText("Note saved.")).toBeInTheDocument();
  const createdDetailsSection = (
    await screen.findByRole("heading", { name: "Watch idle after test drive" })
  ).closest("section");
  expect(createdDetailsSection).not.toBeNull();
  await waitFor(() => {
    const createdLinkedItemSummary = within(createdDetailsSection)
      .getByText("Linked item")
      .closest("div");
    expect(createdLinkedItemSummary).not.toBeNull();
    expect(
      within(createdLinkedItemSummary).getByText("Rough idle at stoplight")
    ).toBeInTheDocument();
    expect(within(createdLinkedItemSummary).getByText("Symptom")).toBeInTheDocument();
    expect(
      within(createdLinkedItemSummary).getByRole("link", {
        name: "Open linked symptom Rough idle at stoplight",
      })
    ).toHaveAttribute("href", "/symptoms?symptomId=21#symptom-library");
  });
  expect(screen.getByText("Engine - Monitoring")).toBeInTheDocument();

  const createCall = fetchMock.mock.calls.find(
    ([url, options]) => url === "/api/notes" && options?.method === "POST"
  );

  expect(createCall).toBeTruthy();
  expect(JSON.parse(createCall[1].body)).toMatchObject({
    title: "Watch idle after test drive",
    noteType: "observation",
    relatedEntityType: "symptom",
    relatedEntityId: 21,
  });

  fireEvent.click(screen.getByRole("button", { name: "Edit note" }));

  const editForm = screen.getByRole("button", { name: "Save changes" }).closest("form");
  expect(editForm).not.toBeNull();
  const editScope = within(editForm);

  fireEvent.change(editScope.getAllByRole("combobox")[1], {
    target: {
      value: "procedure",
    },
  });
  fireEvent.change(editScope.getAllByRole("combobox")[2], {
    target: {
      value: "31",
    },
  });

  fireEvent.click(editScope.getByRole("button", { name: "Save changes" }));

  expect(await screen.findByText("Changes saved.")).toBeInTheDocument();

  await waitFor(() => {
    const updatedLinkedItemSummary = within(createdDetailsSection)
      .getByText("Linked item")
      .closest("div");
    expect(updatedLinkedItemSummary).not.toBeNull();
    expect(
      within(updatedLinkedItemSummary).getByText("Spark plug replacement")
    ).toBeInTheDocument();
    expect(within(updatedLinkedItemSummary).getByText("Procedure")).toBeInTheDocument();
    expect(
      within(updatedLinkedItemSummary).getByRole("link", {
        name: "Open linked procedure Spark plug replacement",
      })
    ).toHaveAttribute("href", "/procedures?procedureId=31#procedure-library");
    expect(screen.getByText("Engine - Beginner")).toBeInTheDocument();
  });

  const editCall = fetchMock.mock.calls.find(
    ([url, options]) => url === "/api/notes/2" && options?.method === "PUT"
  );

  expect(editCall).toBeTruthy();
  expect(JSON.parse(editCall[1].body)).toMatchObject({
    relatedEntityType: "procedure",
    relatedEntityId: 31,
  });
});
