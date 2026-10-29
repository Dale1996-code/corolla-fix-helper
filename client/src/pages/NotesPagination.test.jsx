import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { NotesPage } from "./NotesPage";
import { buildNote, createNotesApi } from "../test/notesApiMock";

// N7 for Notes: the list is paged, filtered, and sorted by the server, so the
// page holds one page of rows and never downloads every note. Every record here
// is synthetic.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// 60 notes. `buildNote` stamps each one a second after the last, so "Newest
// first" is highest id first: page 1 is 60-36, page 2 is 35-11, page 3 is 10-1.
const NOTES = Array.from({ length: 60 }, (_, index) =>
  buildNote(index + 1, { noteType: index % 2 === 0 ? "reminder" : "observation" })
);

function UrlProbe() {
  const location = useLocation();

  return <span data-testid="url">{`${location.pathname}${location.search}`}</span>;
}

const currentUrl = () => screen.getByTestId("url").textContent;

function renderNotes({ notes = NOTES, entry = "/notes" } = {}) {
  const api = createNotesApi({ notes });
  vi.stubGlobal("fetch", vi.fn(api.fetch));

  render(
    <MemoryRouter initialEntries={[entry]}>
      <NotesPage />
      <UrlProbe />
    </MemoryRouter>
  );

  return api;
}

const rowTitles = () =>
  screen
    .queryAllByRole("button", { name: /^Select note:/ })
    .map((button) => button.getAttribute("aria-label").replace("Select note: ", ""));

// "Page 2 of 3" is split across <span>s for its bold numbers.
async function expectPageIndicator(expectedText) {
  await waitFor(() =>
    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName === "SPAN" && element.textContent.replace(/\s+/g, " ") === expectedText
      )
    ).toBeInTheDocument()
  );
}

test("the first view is one bounded page, with no whole-collection downloads", async () => {
  const api = renderNotes();

  await waitFor(() => expect(rowTitles()).toHaveLength(25));
  expect(rowTitles()[0]).toBe("Note 060");
  expect(rowTitles().at(-1)).toBe("Note 036");
  expect(screen.getByText("Showing 1–25 of 60 notes.")).toBeInTheDocument();
  await expectPageIndicator("Page 1 of 3");

  expect(api.listRequests).toHaveLength(1);
  expect(Object.fromEntries(api.listRequests[0])).toEqual({
    limit: "25",
    offset: "0",
    sort: "newest",
  });
  // Nothing asked for /api/notes, /api/documents, /api/symptoms, or
  // /api/procedures whole, and no picker has searched before a link is chosen.
  expect(api.fullListRequests).toEqual([]);
  expect(api.pickerRequests).toEqual([]);
});

test("Next and Previous walk the page boundaries the server reports", async () => {
  renderNotes();
  await waitFor(() => expect(rowTitles()).toHaveLength(25));

  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(rowTitles()[0]).toBe("Note 035"));
  expect(rowTitles().at(-1)).toBe("Note 011");
  expect(screen.getByText("Showing 26–50 of 60 notes.")).toBeInTheDocument();
  expect(currentUrl()).toBe("/notes?page=2");

  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(rowTitles()).toHaveLength(10));
  expect(rowTitles().at(-1)).toBe("Note 001");
  await expectPageIndicator("Page 3 of 3");
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  await waitFor(() => expect(rowTitles()[0]).toBe("Note 035"));
  expect(currentUrl()).toBe("/notes?page=2");
});

test("a filter is applied over every note, starts from page 1, and says what it narrowed", async () => {
  const api = renderNotes({ entry: "/notes?page=2" });
  await waitFor(() => expect(rowTitles()[0]).toBe("Note 035"));

  // "Note type" also labels the create form's field, so the filter is found by
  // its own default option.
  fireEvent.change(screen.getByDisplayValue("All note types"), { target: { value: "reminder" } });

  // 30 reminders over two pages; the filter dropped `page`.
  expect(
    await screen.findByText("Showing 1–25 of 30 notes. Filtered from 60 in your library.")
  ).toBeInTheDocument();
  expect(currentUrl()).toBe("/notes?noteType=reminder");
  expect(api.listRequests.at(-1).get("noteType")).toBe("reminder");
  expect(api.listRequests.at(-1).get("offset")).toBe("0");
  await expectPageIndicator("Page 1 of 2");
});

test("a note outside the loaded page opens by id, and a missing one drops out of the URL", async () => {
  // Note 3 is on page 3; the deep link opens it without loading that page.
  const api = renderNotes({ entry: "/notes?noteId=3" });

  expect(await screen.findByRole("heading", { name: "Note 003" })).toBeInTheDocument();
  expect(api.lookups).toEqual(["/api/notes/3"]);
  expect(rowTitles()).not.toContain("Note 003");
  expect(currentUrl()).toBe("/notes?noteId=3");
});

test("an id no note has is cleared from the URL by the server's 404", async () => {
  const api = renderNotes({ entry: "/notes?noteId=999" });

  await waitFor(() => expect(currentUrl()).toBe("/notes"));
  expect(api.lookups).toEqual(["/api/notes/999"]);
  // The page falls back to its first row.
  expect(await screen.findByRole("heading", { name: "Note 060" })).toBeInTheDocument();
});

test("a page past the end steps back to the last real page", async () => {
  renderNotes({ entry: "/notes?page=9" });

  await waitFor(() => expect(currentUrl()).toBe("/notes?page=3"));
  await waitFor(() => expect(rowTitles()).toHaveLength(10));
  await expectPageIndicator("Page 3 of 3");
});

test("creating a note shows it at once, and the reload refreshes the counts", async () => {
  const api = renderNotes();
  await waitFor(() => expect(rowTitles()).toHaveLength(25));

  fireEvent.change(screen.getByPlaceholderText("Idle note after coil replacement"), {
    target: { value: "Brand new note" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save note" }));

  expect(await screen.findByText("Note saved.")).toBeInTheDocument();
  expect(await screen.findByRole("heading", { name: "Brand new note" })).toBeInTheDocument();
  expect(api.writes.filter((write) => write.method === "POST")).toHaveLength(1);
  await waitFor(() => expect(rowTitles()[0]).toBe("Brand new note"));
  expect(screen.getByText("Showing 1–25 of 61 notes.")).toBeInTheDocument();
}, 10000);

test("deleting the only row on the last page steps back a page", async () => {
  const api = renderNotes({ notes: NOTES.slice(0, 51), entry: "/notes?page=3" });
  await waitFor(() => expect(rowTitles()).toHaveLength(1));
  expect(rowTitles()[0]).toBe("Note 001");

  vi.spyOn(window, "confirm").mockReturnValue(true);
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

  await waitFor(() => expect(currentUrl()).toBe("/notes?page=2"));
  await waitFor(() => expect(rowTitles()).toHaveLength(25));
  expect(api.writes.some((write) => write.method === "DELETE")).toBe(true);
  expect(screen.getByText("Showing 26–50 of 50 notes.")).toBeInTheDocument();
}, 10000);
