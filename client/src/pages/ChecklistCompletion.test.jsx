import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { RepairChecklistsPage } from "./RepairChecklistsPage";

// Completing a checklist into repair history, from the browser (roadmap N3.3).
//
// Two rules are load-bearing here and both are asserted rather than described:
//
//   1. THE BODY CARRIES FACTS ONLY. A title, a `sources` array, or a document
//      id sent from the browser would make the browser the authority on what
//      backed a repair, which is the one thing the whole N3.2 chain exists to
//      prevent. The server ignores such fields; this page must not send them.
//   2. DONE IS NOT RECORDED. `status = "done"` is an organizational state, so
//      completion state is read from the server's `repairHistoryId` and never
//      inferred from the status -- which is what makes a reload land on
//      "Recorded in Repair History" instead of a blank form.

function jsonResponse(payload, ok = true, status = ok ? 200 : 400) {
  return Promise.resolve({ ok, status, json: async () => payload });
}

// TextField renders its help text inside the <label>, so the field's computed
// label text is the caption plus the hint. Matched on the caption.
const ODOMETER_LABEL = /^Odometer \(miles\)/;

const SYMPTOMS = [
  { id: 5, title: "Pulsating brake pedal" },
  { id: 6, title: "Coolant smell" },
];

function buildChecklist(overrides = {}) {
  return {
    id: 31,
    title: "Front brake job",
    status: "planned",
    description: "",
    notes: "",
    items: [],
    itemCount: 0,
    doneItemCount: 0,
    sources: [],
    sourceCount: 0,
    repairHistoryId: null,
    createdAt: "2026-05-02 08:00:00",
    updatedAt: "2026-05-02 09:00:00",
    ...overrides,
  };
}

function buildRepairHistory(overrides = {}) {
  return {
    id: 77,
    performedOn: "2026-08-20",
    odometerMiles: 183456,
    title: "Front brake job",
    outcome: "fixed",
    summary: "",
    followUp: "",
    symptomId: null,
    symptomTitle: "",
    checklistId: 31,
    checklistTitle: "Front brake job",
    sources: [],
    sourceCount: 0,
    createdAt: "2026-08-21 09:00:00",
    updatedAt: "2026-08-21 09:00:00",
    ...overrides,
  };
}

// A response the test releases by hand. No timers and no polling: the whole
// point of the tests below is that a response lands at a moment the test chose,
// so the ordering they assert is the ordering they actually produced.
function releasableResponse() {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });

  return { held, release };
}

/**
 * @param {{
 *   checklists?: object[],
 *   onComplete?: (body: object) => object,
 *   holdCompletion?: Promise<unknown>,
 * }} [options]
 */
function stubChecklistsApi({ checklists = [buildChecklist()], onComplete, holdCompletion } = {}) {
  const fetchMock = vi.fn((url, options = {}) => {
    const method = options.method || "GET";

    if (url === "/api/repair-checklists" && method === "GET") {
      return jsonResponse({ checklists, total: checklists.length });
    }

    // The symptom picker searches a page at a time (N7); nothing asks for the
    // whole symptom collection.
    if (String(url).startsWith("/api/search/symptoms?") && method === "GET") {
      return jsonResponse({ results: SYMPTOMS, total: SYMPTOMS.length, hasMore: false });
    }

    if (String(url).endsWith("/complete") && method === "POST") {
      const body = JSON.parse(options.body);
      const completedId = Number(String(url).split("/").at(-2));
      const source = checklists.find((entry) => entry.id === completedId) || buildChecklist();
      const result = onComplete ? onComplete(body, completedId) : {};

      const response = jsonResponse(
        {
          message: "Repair recorded from your checklist.",
          repairHistory: buildRepairHistory({ checklistId: completedId }),
          // The server answers with the checklist it just recorded, not with
          // whichever one the browser happens to be showing.
          checklist: { ...source, status: "done", repairHistoryId: 77 },
          created: true,
          ...result.payload,
        },
        result.ok !== false,
        result.status || 201
      );

      return holdCompletion ? holdCompletion.then(() => response) : response;
    }

    if (String(url).startsWith("/api/repair-checklists/") && method === "PUT") {
      return jsonResponse({
        message: "Checklist updated.",
        checklist: buildChecklist({ ...JSON.parse(options.body) }),
      });
    }

    throw new Error(`Unexpected fetch call: ${method} ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

async function renderChecklists(options) {
  const fetchMock = stubChecklistsApi(options);

  render(
    <MemoryRouter initialEntries={["/repair-checklists"]}>
      <RepairChecklistsPage />
    </MemoryRouter>
  );

  await screen.findByRole("heading", { level: 2, name: "Front brake job" });

  return fetchMock;
}

async function openCompletionForm() {
  fireEvent.click(screen.getByRole("button", { name: "Record completed repair" }));

  return screen.findByRole("heading", { level: 3, name: "Record completed repair" });
}

function completionForm() {
  return screen.getByRole("heading", { level: 3, name: "Record completed repair" }).closest("form");
}

// The status region announcing this text. An open completion form's symptom
// picker has a status line of its own ("Showing 1–2 of 2 symptoms."), so the
// first status on the page is not necessarily the one under test.
function findStatus(text) {
  return waitFor(() => {
    const status = screen.getAllByRole("status").find((node) => node.textContent.includes(text));
    expect(status).toBeTruthy();
    return status;
  });
}

function completionRequests(fetchMock) {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/complete"));
}

function completionBody(fetchMock) {
  const [call] = completionRequests(fetchMock);

  return call ? JSON.parse(call[1].body) : null;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("the action that writes history is named for what it does", async () => {
  await renderChecklists();

  // Not a bare "Complete": on a page of tick boxes that reads as "tick every
  // item", and this button writes a permanent record instead.
  expect(screen.getByRole("button", { name: "Record completed repair" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Complete$/ })).not.toBeInTheDocument();
});

test("the completion form asks only for facts the server cannot derive", async () => {
  await renderChecklists();
  await openCompletionForm();

  const form = completionForm();

  expect(within(form).getByLabelText(/Repair date/)).toBeInTheDocument();
  expect(within(form).getByLabelText(ODOMETER_LABEL)).toBeInTheDocument();
  expect(within(form).getByLabelText("Outcome")).toBeInTheDocument();
  expect(within(form).getByRole("group", { name: "Symptom" })).toBeInTheDocument();
  expect(within(form).getByLabelText("What was done")).toBeInTheDocument();
  expect(within(form).getByLabelText("Follow-up")).toBeInTheDocument();

  // The two the server owns are absent by construction, not merely ignored.
  expect(within(form).queryByLabelText(/^Title/)).not.toBeInTheDocument();
  expect(within(form).queryByLabelText(/source/i)).not.toBeInTheDocument();
  expect(within(form).queryByLabelText(/document/i)).not.toBeInTheDocument();
});

test("the date field is a real date input and the only required one", async () => {
  await renderChecklists();
  await openCompletionForm();

  const dateInput = within(completionForm()).getByLabelText(/Repair date/);

  expect(dateInput).toHaveAttribute("type", "date");
  expect(dateInput).toBeRequired();
  // The odometer is deliberately NOT a number input: that widget discards what
  // it cannot parse, so a mistyped reading would vanish unexplained instead of
  // being reported.
  const odometerInput = within(completionForm()).getByLabelText(ODOMETER_LABEL);
  expect(odometerInput).not.toHaveAttribute("type", "number");
  expect(odometerInput).toHaveAttribute("inputmode", "numeric");
  expect(odometerInput).not.toBeRequired();
  // No future-date rule is invented here: the server has none, and recording
  // scheduled work is legitimate.
  expect(dateInput).not.toHaveAttribute("max");
});

test("opening the form moves focus into it, and cancelling gives it back", async () => {
  await renderChecklists();

  await openCompletionForm();
  expect(within(completionForm()).getByLabelText(/Repair date/)).toHaveFocus();

  fireEvent.click(within(completionForm()).getByRole("button", { name: "Cancel" }));

  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Record completed repair" })).toBeInTheDocument()
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Record completed repair" })).toHaveFocus()
  );
});

test("outcomes are offered as words and sent as the stored value", async () => {
  const fetchMock = await renderChecklists();
  await openCompletionForm();

  const form = completionForm();
  const outcome = within(form).getByLabelText("Outcome");

  expect(
    [...outcome.options].map((option) => ({ value: option.value, label: option.textContent }))
  ).toEqual([
    { value: "fixed", label: "Fixed" },
    { value: "partial", label: "Partially fixed" },
    { value: "not_fixed", label: "Not fixed" },
    { value: "unknown", label: "Unknown" },
  ]);

  fireEvent.change(within(form).getByLabelText(/Repair date/), {
    target: { value: "2026-08-20" },
  });
  fireEvent.change(outcome, { target: { value: "not_fixed" } });
  fireEvent.submit(form);

  await waitFor(() => expect(completionBody(fetchMock)).not.toBeNull());
  expect(completionBody(fetchMock).outcome).toBe("not_fixed");
});

test("sends exactly the historical facts, and nothing the server owns", async () => {
  const fetchMock = await renderChecklists();
  await openCompletionForm();

  const form = completionForm();

  fireEvent.change(within(form).getByLabelText(/Repair date/), {
    target: { value: "2026-08-20" },
  });
  fireEvent.change(within(form).getByLabelText(ODOMETER_LABEL), {
    target: { value: "183456" },
  });
  fireEvent.change(within(form).getByLabelText("Outcome"), { target: { value: "fixed" } });
  fireEvent.click(await within(form).findByRole("radio", { name: /Pulsating brake pedal/ }));
  fireEvent.change(within(form).getByLabelText("What was done"), {
    target: { value: "New pads and rotors." },
  });
  fireEvent.change(within(form).getByLabelText("Follow-up"), {
    target: { value: "Re-check at the next oil change." },
  });
  fireEvent.submit(form);

  await waitFor(() => expect(completionBody(fetchMock)).not.toBeNull());

  const body = completionBody(fetchMock);

  expect(Object.keys(body).sort()).toEqual([
    "followUp",
    "odometerMiles",
    "outcome",
    "performedOn",
    "summary",
    "symptomId",
  ]);
  expect(body).toEqual({
    performedOn: "2026-08-20",
    odometerMiles: 183456,
    outcome: "fixed",
    summary: "New pads and rotors.",
    followUp: "Re-check at the next oil change.",
    symptomId: 5,
  });
});

test("a nonblank odometer is sent as a JSON number, not the typed string", async () => {
  const fetchMock = await renderChecklists();
  await openCompletionForm();

  const form = completionForm();

  fireEvent.change(within(form).getByLabelText(/Repair date/), {
    target: { value: "2026-08-20" },
  });
  fireEvent.change(within(form).getByLabelText(ODOMETER_LABEL), {
    target: { value: "183456" },
  });
  fireEvent.submit(form);

  await waitFor(() => expect(completionBody(fetchMock)).not.toBeNull());

  const { odometerMiles } = completionBody(fetchMock);

  expect(odometerMiles).toBe(183456);
  expect(typeof odometerMiles).toBe("number");
});

test("a blank odometer is sent as null, never as zero", async () => {
  const fetchMock = await renderChecklists();
  await openCompletionForm();

  const form = completionForm();

  fireEvent.change(within(form).getByLabelText(/Repair date/), {
    target: { value: "2026-08-20" },
  });
  fireEvent.submit(form);

  await waitFor(() => expect(completionBody(fetchMock)).not.toBeNull());

  const body = completionBody(fetchMock);

  // "I did not write it down" and "the odometer read zero" are different facts.
  expect(body.odometerMiles).toBeNull();
  expect(body.odometerMiles).not.toBe(0);
  expect(body.symptomId).toBeNull();
});

test("refuses an odometer that is not a whole number of miles before sending it", async () => {
  const fetchMock = await renderChecklists();
  await openCompletionForm();

  const form = completionForm();

  fireEvent.change(within(form).getByLabelText(/Repair date/), {
    target: { value: "2026-08-20" },
  });
  fireEvent.change(within(form).getByLabelText(ODOMETER_LABEL), {
    target: { value: "183,456" },
  });
  fireEvent.submit(form);

  expect(await screen.findByRole("alert")).toHaveTextContent(/whole number of miles/i);
  expect(completionBody(fetchMock)).toBeNull();
});

test("a missing repair date is refused before a request is made", async () => {
  const fetchMock = await renderChecklists();
  await openCompletionForm();

  fireEvent.submit(completionForm());

  expect(await screen.findByRole("alert")).toHaveTextContent("Repair date is required.");
  expect(completionBody(fetchMock)).toBeNull();
});

test("a successful completion updates the checklist and offers the new record", async () => {
  await renderChecklists();
  await openCompletionForm();

  const form = completionForm();

  fireEvent.change(within(form).getByLabelText(/Repair date/), {
    target: { value: "2026-08-20" },
  });
  fireEvent.submit(form);

  expect(await findStatus("Repair recorded.")).toHaveTextContent("Repair recorded.");
  expect(screen.getByText("Recorded in Repair History")).toBeInTheDocument();

  // The link is built from the id the server returned, never manufactured.
  expect(screen.getByRole("link", { name: "Open the repair record" })).toHaveAttribute(
    "href",
    "/repair-history?repairHistoryId=77#repair-history-library"
  );

  // The server-returned checklist is what the panel now shows.
  expect(screen.getAllByText("Done").length).toBeGreaterThan(0);
  // ...and the form is gone, so the same repair cannot be entered twice.
  expect(
    screen.queryByRole("heading", { level: 3, name: "Record completed repair" })
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Record completed repair" })
  ).not.toBeInTheDocument();
});

test("an already-recorded response is treated as recorded, not as an error", async () => {
  await renderChecklists({
    onComplete: () => ({
      status: 200,
      payload: {
        message: "This checklist was already completed as a repair.",
        created: false,
      },
    }),
  });

  await openCompletionForm();

  const form = completionForm();

  fireEvent.change(within(form).getByLabelText(/Repair date/), {
    target: { value: "2026-08-20" },
  });
  fireEvent.submit(form);

  // 200 + created:false is an answer -- one checklist is one repair -- so it is
  // reported as a status, never as an alert.
  expect(await findStatus("already recorded")).toHaveTextContent(
    "This checklist was already recorded as a repair."
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open the repair record" })).toBeInTheDocument();
});

test("a failed completion reports the server's reason and keeps the form open", async () => {
  await renderChecklists({
    onComplete: () => ({
      ok: false,
      status: 400,
      payload: { error: "Linked symptom does not exist." },
    }),
  });

  await openCompletionForm();

  const form = completionForm();

  fireEvent.change(within(form).getByLabelText(/Repair date/), {
    target: { value: "2026-08-20" },
  });
  fireEvent.submit(form);

  // The server's own sentence, not a generic one -- and the form stays open so
  // what was typed is still there to correct.
  expect(await screen.findByRole("alert")).toHaveTextContent("Linked symptom does not exist.");
  expect(
    screen.getByRole("heading", { level: 3, name: "Record completed repair" })
  ).toBeInTheDocument();
  expect(within(completionForm()).getByLabelText(/Repair date/)).toHaveValue("2026-08-20");
  expect(screen.queryByText("Recorded in Repair History")).not.toBeInTheDocument();
});

test("an already-recorded checklist reads as recorded on a cold load", async () => {
  // The reload case: nothing this page did in a previous session is remembered,
  // so the panel is rebuilt from the server's own field alone.
  await renderChecklists({
    checklists: [buildChecklist({ status: "done", repairHistoryId: 77 })],
  });

  expect(screen.getByText("Recorded in Repair History")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open the repair record" })).toHaveAttribute(
    "href",
    "/repair-history?repairHistoryId=77#repair-history-library"
  );
  // No blank form inviting a second record of the same job.
  expect(
    screen.queryByRole("button", { name: "Record completed repair" })
  ).not.toBeInTheDocument();
});

test("a checklist merely marked done still offers to record the repair", async () => {
  // THE DISTINCTION N3.2 established: done is an organizational state and
  // records nothing, so completion state must not be inferred from it.
  await renderChecklists({
    checklists: [buildChecklist({ status: "done", repairHistoryId: null })],
  });

  expect(screen.getByRole("button", { name: "Record completed repair" })).toBeInTheDocument();
  expect(screen.queryByText("Recorded in Repair History")).not.toBeInTheDocument();
});

test("marking a checklist done through the edit form records no repair", async () => {
  const fetchMock = await renderChecklists();

  fireEvent.click(screen.getByRole("button", { name: "Edit checklist" }));

  // "Status" also labels a field on the create form above, so scope to the edit
  // form this test just opened.
  const editForm = (await screen.findByRole("button", { name: "Save changes" })).closest("form");

  fireEvent.change(within(editForm).getByLabelText("Status"), { target: { value: "done" } });
  fireEvent.click(within(editForm).getByRole("button", { name: "Save changes" }));

  await screen.findByText("Changes saved.");

  // Setting the status is a PUT and nothing else -- no completion request, and
  // no claim that a repair now exists.
  expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/complete"))).toBe(false);
  expect(screen.queryByText("Recorded in Repair History")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Record completed repair" })).toBeInTheDocument();
});

test("the symptom picker is optional, searched a page at a time, and loaded only when the form opens", async () => {
  const fetchMock = await renderChecklists();
  const symptomRequests = () =>
    fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes("symptoms"));

  // Not fetched until the form is opened: an optional link should not cost
  // every visit to this page a second request.
  expect(symptomRequests()).toEqual([]);

  await openCompletionForm();
  const form = within(completionForm());

  expect(await form.findByText("No symptom linked.")).toBeInTheDocument();
  expect(form.getAllByRole("radio").map((radio) => radio.closest("label").textContent)).toEqual([
    expect.stringContaining("Pulsating brake pedal"),
    expect.stringContaining("Coolant smell"),
  ]);
  expect(form.getAllByRole("radio").some((radio) => radio.checked)).toBe(false);

  // One bounded page, never the whole collection (N7).
  expect(symptomRequests().length).toBeGreaterThan(0);
  for (const url of symptomRequests()) {
    expect(url).toMatch(/^\/api\/search\/symptoms\?.*limit=25/);
  }
});

test("a chosen symptom can be cleared back to no symptom", async () => {
  const fetchMock = await renderChecklists();
  await openCompletionForm();

  const form = completionForm();

  fireEvent.change(within(form).getByLabelText(/Repair date/), {
    target: { value: "2026-08-20" },
  });
  fireEvent.click(await within(form).findByRole("radio", { name: /Coolant smell/ }));
  expect(within(form).getByText("Linked to Coolant smell.")).toBeInTheDocument();
  fireEvent.click(within(form).getByRole("button", { name: "No symptom" }));
  expect(within(form).getByText("No symptom linked.")).toBeInTheDocument();
  fireEvent.submit(form);

  await waitFor(() => expect(completionBody(fetchMock)).not.toBeNull());
  expect(completionBody(fetchMock).symptomId).toBeNull();
});

// --- Whose completion is this? --------------------------------------------
//
// A completion request outlives the screen that sent it. The owner can select
// another checklist and open its form while the first request is still on the
// wire, and the response -- which knows nothing about any of that -- must not
// close that form, empty it, or report itself underneath it. What the response
// legitimately owns is the CHECKLIST it recorded, and that is applied wherever
// the owner happens to be.

const REAR_BRAKES = buildChecklist({
  id: 32,
  title: "Rear brake job",
  createdAt: "2026-05-01 08:00:00",
  updatedAt: "2026-05-01 09:00:00",
});

async function submitFrontBrakeCompletionAndSwitchToRear() {
  await openCompletionForm();
  fireEvent.change(within(completionForm()).getByLabelText(/Repair date/), {
    target: { value: "2026-08-20" },
  });
  fireEvent.submit(completionForm());

  fireEvent.click(screen.getByRole("button", { name: "Select checklist: Rear brake job" }));
  await screen.findByRole("heading", { level: 2, name: "Rear brake job" });
}

async function openRearBrakeCompletionForm() {
  await openCompletionForm();
  fireEvent.change(within(completionForm()).getByLabelText(/Repair date/), {
    target: { value: "2026-09-01" },
  });
  fireEvent.change(within(completionForm()).getByLabelText("What was done"), {
    target: { value: "New shoes and hardware." },
  });
}

// The list row is the one place both checklists are visible at once, so it is
// how these tests observe a checklist they are not looking at.
function checklistRow(title) {
  return screen.getByRole("button", { name: `Select checklist: ${title}` });
}

test("a completion still in flight cannot close or empty another checklist's form", async () => {
  const completion = releasableResponse();

  await renderChecklists({
    checklists: [buildChecklist(), REAR_BRAKES],
    holdCompletion: completion.held,
  });

  await submitFrontBrakeCompletionAndSwitchToRear();
  await openRearBrakeCompletionForm();

  completion.release();

  // The front brake job's own row is how we know its response has been handled.
  await waitFor(() => expect(within(checklistRow("Front brake job")).getByText("Done")).toBeInTheDocument());

  // The rear brake job's form is untouched: still open, still holding what was
  // typed into it, and still offering to record ITS repair.
  const rearForm = completionForm();

  expect(within(rearForm).getByLabelText(/Repair date/)).toHaveValue("2026-09-01");
  expect(within(rearForm).getByLabelText("What was done")).toHaveValue("New shoes and hardware.");
  expect(within(rearForm).getByRole("button", { name: "Record repair" })).toBeEnabled();

  // ...and the front brake job's success is not announced underneath it.
  expect(screen.queryByText(/Repair recorded/)).not.toBeInTheDocument();
  expect(screen.queryByText("Recorded in Repair History")).not.toBeInTheDocument();
});

test("a completion that lands late still records the checklist it belongs to", async () => {
  const completion = releasableResponse();

  await renderChecklists({
    checklists: [buildChecklist(), REAR_BRAKES],
    holdCompletion: completion.held,
  });

  await submitFrontBrakeCompletionAndSwitchToRear();
  await openRearBrakeCompletionForm();

  completion.release();

  await waitFor(() => expect(within(checklistRow("Front brake job")).getByText("Done")).toBeInTheDocument());

  // Scoping the banner must not cost the update itself: the checklist the
  // server returned is the truth about that checklist, so going back to it
  // shows the repair rather than an invitation to record it a second time.
  fireEvent.click(checklistRow("Front brake job"));

  await screen.findByRole("heading", { level: 2, name: "Front brake job" });
  expect(screen.getByText("Recorded in Repair History")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Record completed repair" })
  ).not.toBeInTheDocument();
});

test("a second completion is refused while one is still being recorded, and says why", async () => {
  const completion = releasableResponse();

  const fetchMock = await renderChecklists({
    checklists: [buildChecklist(), REAR_BRAKES],
    holdCompletion: completion.held,
  });

  await submitFrontBrakeCompletionAndSwitchToRear();
  await openRearBrakeCompletionForm();

  fireEvent.submit(completionForm());

  // Refused out loud. A press that quietly did nothing would read as a broken
  // button, and the owner would keep pressing it.
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Another repair is still being recorded."
  );
  expect(completionRequests(fetchMock)).toHaveLength(1);
  expect(within(completionForm()).getByLabelText(/Repair date/)).toHaveValue("2026-09-01");

  // And it is a wait, not a lock: once the first repair is recorded the second
  // one records normally.
  completion.release();
  await waitFor(() => expect(within(checklistRow("Front brake job")).getByText("Done")).toBeInTheDocument());

  fireEvent.submit(completionForm());

  await waitFor(() => expect(completionRequests(fetchMock)).toHaveLength(2));
  expect(await findStatus("Repair recorded.")).toHaveTextContent("Repair recorded.");
  expect(completionRequests(fetchMock)[1][0]).toBe("/api/repair-checklists/32/complete");
});

test("recording a repair moves focus to the record it just created", async () => {
  await renderChecklists();
  await openCompletionForm();

  fireEvent.change(within(completionForm()).getByLabelText(/Repair date/), {
    target: { value: "2026-08-20" },
  });
  fireEvent.submit(completionForm());

  // The form the keyboard user was in has just been removed. Focus follows the
  // thing that replaced it rather than falling back to the top of the document.
  const recordLink = await screen.findByRole("link", { name: "Open the repair record" });

  await waitFor(() => expect(recordLink).toHaveFocus());
});
