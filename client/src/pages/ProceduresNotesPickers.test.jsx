import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { NotesPage } from "./NotesPage";
import { ProceduresPage } from "./ProceduresPage";
import { buildNote, createNotesApi } from "../test/notesApiMock";
import { buildProcedure, createProceduresApi } from "../test/proceduresApiMock";

// N7 for Procedures and Notes: their link pickers search one bounded page at a
// time, so neither page downloads the document library (1,443 documents, about
// 1.2 MiB, on the owner's real library) or another page's whole collection just
// to offer something to link. Every record here is synthetic.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// 30 of each, so a picker's first page (25) leaves some behind.
const DOCUMENTS = Array.from({ length: 30 }, (_, index) => ({
  id: 101 + index,
  title: `Manual ${String(index + 1).padStart(2, "0")}`,
  system: "Brakes",
  documentType: "Repair Manual",
}));
const SYMPTOMS = Array.from({ length: 30 }, (_, index) => ({
  id: 1 + index,
  title: `Symptom ${String(index + 1).padStart(2, "0")}`,
  system: "Engine",
  status: "open",
}));
const PROCEDURES = Array.from({ length: 30 }, (_, index) => ({
  id: 201 + index,
  title: `Procedure ${String(index + 1).padStart(2, "0")}`,
  system: "Brakes",
  difficulty: "beginner",
}));

// A search waits out the picker's debounce and then a request; on a loaded
// machine that can take longer than findBy's default second.
const AFTER_SEARCH = { timeout: 4000 };
const SLOW_TEST_MS = 10000;

function renderProcedures(procedures = []) {
  const api = createProceduresApi({ procedures, documents: DOCUMENTS, symptoms: SYMPTOMS });
  vi.stubGlobal("fetch", vi.fn(api.fetch));

  render(
    <MemoryRouter initialEntries={["/procedures"]}>
      <ProceduresPage />
    </MemoryRouter>
  );

  return api;
}

function renderNotes(notes = []) {
  const api = createNotesApi({
    notes,
    documents: DOCUMENTS,
    symptoms: SYMPTOMS,
    procedures: PROCEDURES,
  });
  vi.stubGlobal("fetch", vi.fn(api.fetch));

  render(
    <MemoryRouter initialEntries={["/notes"]}>
      <NotesPage />
    </MemoryRouter>
  );

  return api;
}

function sectionOf(headingName) {
  return screen.getByRole("heading", { name: headingName }).closest("section");
}

// ---- Procedures ----

test("Procedures downloads no document or symptom library; its pickers search a page", async () => {
  const api = renderProcedures([
    buildProcedure(501, { title: "Front pad replacement", linkedSymptomIds: [3] }),
  ]);

  expect(await screen.findByRole("heading", { name: "Front pad replacement" })).toBeInTheDocument();
  const create = within(sectionOf("Create procedure"));
  expect(await create.findByText("Showing 1–25 of 30 documents.")).toBeInTheDocument();
  expect(await screen.findByText("Showing 1–25 of 30 symptoms. 1 selected.")).toBeInTheDocument();

  // The procedures themselves arrive one page at a time; nothing else downloads.
  expect(api.fullListRequests).toEqual([]);
  expect(api.listRequests).toHaveLength(1);
  expect(api.pickerRequests.length).toBeGreaterThan(0);
  for (const url of api.pickerRequests) {
    expect(url).toMatch(/limit=25/);
  }
}, SLOW_TEST_MS);

test("Procedures links a document found by search when creating", async () => {
  const api = renderProcedures();

  const create = within(sectionOf("Create procedure"));
  await create.findByText("Showing 1–25 of 30 documents.");
  // Manual 27 is past the first page: only a search can reach it.
  expect(create.queryByRole("checkbox", { name: /Manual 27/ })).not.toBeInTheDocument();

  fireEvent.change(create.getByLabelText("Find documents"), { target: { value: "Manual 27" } });
  fireEvent.click(await create.findByRole("checkbox", { name: /Manual 27/ }, AFTER_SEARCH));
  fireEvent.change(create.getByLabelText(/^Title/), { target: { value: "Rear pad replacement" } });
  fireEvent.click(create.getByRole("button", { name: "Save procedure" }));

  expect(await screen.findByText("Procedure saved.")).toBeInTheDocument();
  const write = api.writes.find((entry) => entry.method === "POST");
  expect(write.body.linkedDocumentIds).toEqual([127]);
  expect(api.fullListRequests).toEqual([]);
}, SLOW_TEST_MS);

test("Procedures keeps a linked document the picker's first page does not show", async () => {
  const api = renderProcedures([
    buildProcedure(501, { title: "Front pad replacement", linkedDocumentIds: [130] }),
  ]);

  fireEvent.click(await screen.findByRole("button", { name: "Edit procedure" }));
  const editForm = within(screen.getByRole("button", { name: "Save changes" }).closest("form"));

  // Linked before the edit began, listed first, and still ticked.
  expect(await editForm.findByRole("checkbox", { name: /Manual 30/ })).toBeChecked();
  fireEvent.click(await editForm.findByRole("checkbox", { name: /Manual 02/ }));
  fireEvent.click(editForm.getByRole("button", { name: "Save changes" }));

  expect(await screen.findByText("Changes saved.")).toBeInTheDocument();
  const write = api.writes.find((entry) => entry.method === "PUT");
  expect(write.body.linkedDocumentIds).toEqual([130, 102]);
}, SLOW_TEST_MS);

test("Procedures links symptoms through the searched picker", async () => {
  const api = renderProcedures([
    buildProcedure(501, { title: "Front pad replacement", linkedSymptomIds: [30] }),
  ]);

  expect(await screen.findByRole("link", { name: "Open symptom Symptom 30" })).toBeInTheDocument();
  // Symptom 30 is past the first page, and is still shown ticked.
  expect(await screen.findByRole("checkbox", { name: /Symptom 30/ })).toBeChecked();

  fireEvent.click(await screen.findByRole("checkbox", { name: /Symptom 05/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save linked symptoms" }));

  expect(await screen.findByText("Linked symptoms saved.")).toBeInTheDocument();
  const write = api.writes.find((entry) => entry.path.endsWith("/symptoms"));
  expect(write.body).toEqual({ symptomIds: [30, 5] });
  expect(api.fullListRequests).toEqual([]);
}, SLOW_TEST_MS);

// ---- Notes ----

test("Notes downloads no document, symptom, or procedure library", async () => {
  const api = renderNotes([buildNote(601, { title: "Pad wear reminder", noteType: "reminder" })]);

  expect(await screen.findByRole("heading", { name: "Pad wear reminder" })).toBeInTheDocument();
  expect(api.fullListRequests).toEqual([]);
  // Nothing is offered until a link type is chosen, so nothing is fetched.
  expect(api.pickerRequests).toEqual([]);

  const create = within(sectionOf("Create note"));
  fireEvent.change(create.getByLabelText("Link note to"), { target: { value: "document" } });

  expect(await create.findByText("Showing 1–25 of 30 documents.")).toBeInTheDocument();
  expect(create.getAllByRole("radio")).toHaveLength(25);
  expect(api.pickerRequests.every((url) => url.startsWith("/api/search/documents?"))).toBe(true);
  expect(api.fullListRequests).toEqual([]);
}, SLOW_TEST_MS);

test("Notes links one record found by search when creating", async () => {
  const api = renderNotes();

  const create = within(sectionOf("Create note"));
  fireEvent.change(create.getByLabelText("Link note to"), { target: { value: "document" } });
  await create.findByText("Showing 1–25 of 30 documents.");

  fireEvent.change(create.getByLabelText("Find documents"), { target: { value: "Manual 29" } });
  fireEvent.click(await create.findByRole("radio", { name: /Manual 29/ }, AFTER_SEARCH));
  fireEvent.change(create.getByPlaceholderText("Idle note after coil replacement"), {
    target: { value: "Rotor runout check" },
  });
  fireEvent.click(create.getByRole("button", { name: "Save note" }));

  expect(await screen.findByText("Note saved.")).toBeInTheDocument();
  const write = api.writes.find((entry) => entry.method === "POST");
  expect(write.body).toMatchObject({ relatedEntityType: "document", relatedEntityId: 129 });
}, SLOW_TEST_MS);

test("Notes keeps a link the picker's first page does not show, and a type change clears it", async () => {
  const api = renderNotes([
    buildNote(601, {
      title: "Pad wear reminder",
      relatedEntityType: "document",
      relatedEntityId: 130,
    }),
  ]);

  fireEvent.click(await screen.findByRole("button", { name: "Edit note" }));
  let editForm = within(screen.getByRole("button", { name: "Save changes" }).closest("form"));
  expect(await editForm.findByRole("radio", { name: /Manual 30/ })).toBeChecked();
  fireEvent.click(editForm.getByRole("button", { name: "Save changes" }));

  expect(await screen.findByText("Changes saved.")).toBeInTheDocument();
  expect(api.writes.at(-1).body).toMatchObject({ relatedEntityType: "document", relatedEntityId: 130 });

  fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
  editForm = within(screen.getByRole("button", { name: "Save changes" }).closest("form"));
  fireEvent.change(editForm.getByLabelText("Link note to"), { target: { value: "procedure" } });

  await editForm.findByText("Showing 1–25 of 30 procedures.");
  // The document link does not follow the note into the procedure picker.
  expect(editForm.getAllByRole("radio").some((radio) => radio.checked)).toBe(false);
  fireEvent.click(editForm.getByRole("radio", { name: /Procedure 07/ }));
  fireEvent.click(editForm.getByRole("button", { name: "Save changes" }));

  await waitFor(() =>
    expect(api.writes.at(-1).body).toMatchObject({
      relatedEntityType: "procedure",
      relatedEntityId: 207,
    })
  );
  expect(api.fullListRequests).toEqual([]);
}, SLOW_TEST_MS);

test("Notes still saves a note whose linked record was deleted", async () => {
  // The server drops a link that was already dead when an edit keeps it (audit
  // 1B-05), so the page must send it back rather than refuse the edit.
  const api = renderNotes([
    buildNote(601, {
      title: "Pad wear reminder",
      relatedEntityType: "document",
      relatedEntityId: 999,
    }),
  ]);

  fireEvent.click(await screen.findByRole("button", { name: "Edit note" }));
  const editForm = within(screen.getByRole("button", { name: "Save changes" }).closest("form"));
  expect(await editForm.findByRole("radio", { name: /Document #999/ })).toBeChecked();
  fireEvent.click(editForm.getByRole("button", { name: "Save changes" }));

  await waitFor(() => expect(api.writes.at(-1)?.method).toBe("PUT"));
  expect(api.writes.at(-1).body).toMatchObject({ relatedEntityType: "document", relatedEntityId: 999 });
}, SLOW_TEST_MS);
