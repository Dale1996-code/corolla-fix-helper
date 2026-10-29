import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RecordPicker } from "./RecordPicker";

// The picker lives inside other pages' submit forms (create a procedure, save a
// note, record a completed repair). Its search box is a text field, and Enter in
// a text field submits the form around it -- so a keystroke meant to search
// could save a half-finished record. These tests pin that it cannot.

function jsonResponse(payload) {
  return Promise.resolve({ ok: true, status: 200, json: async () => payload });
}

// jsdom does not perform implicit submission, so this does what a browser does
// with Enter in a form's text field: unless a handler cancelled the keydown,
// the form is submitted (with its validation, through `requestSubmit`).
function pressEnter(field) {
  const notCancelled = fireEvent.keyDown(field, { key: "Enter", code: "Enter" });

  if (notCancelled) {
    field.form.requestSubmit();
  }

  return notCancelled;
}

function renderPickerInForm() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      jsonResponse({
        results: [{ id: 5, title: "Pulsating brake pedal" }],
        total: 1,
        hasMore: false,
      })
    )
  );
  const onSubmit = vi.fn((event) => event.preventDefault());

  render(
    <form onSubmit={onSubmit}>
      <label>
        Title
        <input type="text" name="title" />
      </label>
      <RecordPicker
        legend="Linked symptoms"
        endpoint="/api/search/symptoms"
        selected={[]}
        onToggle={() => {}}
        describe={() => ""}
        noun="symptom"
        nounPlural="symptoms"
        searchLabel="Find symptoms"
        searchPlaceholder="Search symptoms"
        emptyLibraryText="No symptoms yet."
      />
      <button type="submit">Save</button>
    </form>
  );

  return onSubmit;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("Enter in the picker's search box never submits the form around it", async () => {
  const onSubmit = renderPickerInForm();
  const searchBox = await screen.findByLabelText("Find symptoms");

  fireEvent.change(searchBox, { target: { value: "brake" } });

  expect(pressEnter(searchBox)).toBe(false);
  expect(onSubmit).not.toHaveBeenCalled();
  // Still a search box: the typed keyword is kept.
  expect(searchBox).toHaveValue("brake");
});

test("the guard is Enter-only and scoped to the search box", async () => {
  const onSubmit = renderPickerInForm();
  const searchBox = await screen.findByLabelText("Find symptoms");

  // Other keys type as usual.
  expect(fireEvent.keyDown(searchBox, { key: "a", code: "KeyA" })).toBe(true);

  // Enter in the host form's own fields still submits it -- which is also what
  // shows `pressEnter` really submits when nothing cancels the keystroke.
  pressEnter(screen.getByLabelText("Title"));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
});
