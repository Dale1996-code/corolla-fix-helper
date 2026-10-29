import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { NotesPage } from "./NotesPage";
import { buildNote, createNotesApi } from "../test/notesApiMock";

// The Notes page asks the server for one filtered, ordered page at a time (N7),
// so these tests run it against a stand-in that applies the same request. Paging
// and deep links are covered in NotesPagination.test.jsx; the link pickers in
// ProceduresNotesPickers.test.jsx. Every record here is synthetic.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderNotes(library, entry = "/notes") {
  const api = createNotesApi(library);
  vi.stubGlobal("fetch", vi.fn(api.fetch));

  render(
    <MemoryRouter initialEntries={[entry]}>
      <NotesPage />
    </MemoryRouter>
  );

  return api;
}

test("NotesPage filters notes by linked item type", async () => {
  const api = renderNotes({
    documents: [
      { id: 11, title: "Ignition system overview", system: "Engine", documentType: "Reference" },
    ],
    symptoms: [{ id: 21, title: "Rough idle at stoplight", system: "Engine", status: "monitoring" }],
    procedures: [{ id: 31, title: "Spark plug replacement", system: "Engine", difficulty: "beginner" }],
    notes: [
      buildNote(1, { title: "Document note", relatedEntityType: "document", relatedEntityId: 11 }),
      buildNote(2, {
        title: "Symptom note",
        noteType: "observation",
        relatedEntityType: "symptom",
        relatedEntityId: 21,
      }),
      buildNote(3, {
        title: "Procedure note",
        noteType: "repair_log",
        relatedEntityType: "procedure",
        relatedEntityId: 31,
      }),
      buildNote(4, { title: "Unlinked note", noteType: "reminder" }),
    ],
  });

  expect((await screen.findAllByText("Document note")).length).toBeGreaterThan(0);
  expect(screen.getAllByText("Symptom note").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Procedure note").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Unlinked note").length).toBeGreaterThan(0);

  fireEvent.change(screen.getByLabelText("Linked item"), {
    target: { value: "symptom" },
  });

  // One match out of four: singular grammar, and the counter says what the
  // list was narrowed from since nothing else on the page shows the total.
  expect(
    await screen.findByText("Showing 1–1 of 1 note. Filtered from 4 in your library.")
  ).toBeInTheDocument();
  expect(api.listRequests.at(-1).get("relatedEntityType")).toBe("symptom");
  expect(screen.getAllByText("Symptom note").length).toBeGreaterThan(0);
  expect(screen.queryAllByText("Document note")).toHaveLength(0);
  expect(screen.queryAllByText("Procedure note")).toHaveLength(0);
  expect(screen.queryAllByText("Unlinked note")).toHaveLength(0);

  fireEvent.change(screen.getByLabelText("Linked item"), {
    target: { value: "none" },
  });

  await waitFor(() => expect(api.listRequests.at(-1).get("relatedEntityType")).toBe("none"));
  expect((await screen.findAllByText("Unlinked note")).length).toBeGreaterThan(0);
  expect(screen.queryAllByText("Document note")).toHaveLength(0);
  expect(screen.queryAllByText("Symptom note")).toHaveLength(0);
  expect(screen.queryAllByText("Procedure note")).toHaveLength(0);
  expect(api.fullListRequests).toEqual([]);
});

test("NotesPage supports symptom and procedure links in create, edit, and details views", async () => {
  const api = renderNotes({
    symptoms: [{ id: 21, title: "Rough idle at stoplight", system: "Engine", status: "monitoring" }],
    procedures: [{ id: 31, title: "Spark plug replacement", system: "Engine", difficulty: "beginner" }],
    notes: [
      buildNote(1, {
        title: "Spark plug torque reminder",
        content: "Double-check the torque spec before reinstalling.",
        noteType: "reminder",
        relatedEntityType: "procedure",
        relatedEntityId: 31,
        createdAt: "2026-04-16T08:00:00.000Z",
        updatedAt: "2026-04-17T09:00:00.000Z",
      }),
    ],
  });

  const initialDetailsSection = (
    await screen.findByRole("heading", { name: "Spark plug torque reminder" })
  ).closest("section");
  expect(initialDetailsSection).not.toBeNull();
  const linkedItemSummary = within(initialDetailsSection).getByText("Linked item").closest("div");
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
    target: { value: "Watch idle after test drive" },
  });
  fireEvent.change(createScope.getAllByRole("combobox")[0], { target: { value: "observation" } });
  fireEvent.change(createScope.getAllByRole("combobox")[1], { target: { value: "symptom" } });
  fireEvent.click(await createScope.findByRole("radio", { name: /Rough idle at stoplight/ }));
  fireEvent.change(createScope.getByPlaceholderText("Write your note here..."), {
    target: { value: "See if the idle drops after the next stoplight." },
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
    expect(within(createdLinkedItemSummary).getByText("Rough idle at stoplight")).toBeInTheDocument();
    expect(within(createdLinkedItemSummary).getByText("Symptom")).toBeInTheDocument();
    expect(
      within(createdLinkedItemSummary).getByRole("link", {
        name: "Open linked symptom Rough idle at stoplight",
      })
    ).toHaveAttribute("href", "/symptoms?symptomId=21#symptom-library");
  });
  expect(screen.getByText("Engine - Monitoring")).toBeInTheDocument();

  const createCall = api.writes.find((write) => write.method === "POST");

  expect(createCall).toBeTruthy();
  expect(createCall.body).toMatchObject({
    title: "Watch idle after test drive",
    noteType: "observation",
    relatedEntityType: "symptom",
    relatedEntityId: 21,
  });

  fireEvent.click(screen.getByRole("button", { name: "Edit note" }));

  const editForm = screen.getByRole("button", { name: "Save changes" }).closest("form");
  expect(editForm).not.toBeNull();
  const editScope = within(editForm);

  fireEvent.change(editScope.getAllByRole("combobox")[1], { target: { value: "procedure" } });
  fireEvent.click(await editScope.findByRole("radio", { name: /Spark plug replacement/ }));

  fireEvent.click(editScope.getByRole("button", { name: "Save changes" }));

  expect(await screen.findByText("Changes saved.")).toBeInTheDocument();

  await waitFor(() => {
    const updatedLinkedItemSummary = within(createdDetailsSection)
      .getByText("Linked item")
      .closest("div");
    expect(updatedLinkedItemSummary).not.toBeNull();
    expect(within(updatedLinkedItemSummary).getByText("Spark plug replacement")).toBeInTheDocument();
    expect(within(updatedLinkedItemSummary).getByText("Procedure")).toBeInTheDocument();
    expect(
      within(updatedLinkedItemSummary).getByRole("link", {
        name: "Open linked procedure Spark plug replacement",
      })
    ).toHaveAttribute("href", "/procedures?procedureId=31#procedure-library");
    expect(screen.getByText("Engine - Beginner")).toBeInTheDocument();
  });

  const editCall = api.writes.find((write) => write.method === "PUT");

  expect(editCall).toBeTruthy();
  expect(editCall.body).toMatchObject({
    relatedEntityType: "procedure",
    relatedEntityId: 31,
  });
  expect(api.fullListRequests).toEqual([]);
}, 15000);
