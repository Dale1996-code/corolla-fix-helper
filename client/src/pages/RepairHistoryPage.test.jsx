import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { RepairHistoryPage } from "./RepairHistoryPage";

// The Repair History page (roadmap N3.3): the owner-facing end of the evidence
// chain N3.1 and N3.2 built server-side.
//
// Most of what is asserted here is one rule seen from different angles -- a
// repair record shows what was TRUE WHEN THE WORK HAPPENED, not what is true
// now. The snapshot title is displayed whether or not the live record survives;
// the live id only decides whether there is also something to open.

function jsonResponse(payload, ok = true) {
  return Promise.resolve({ ok, json: async () => payload });
}

const BRAKE_JOB = {
  id: 11,
  performedOn: "2026-08-20",
  odometerMiles: 183456,
  title: "Front brake job",
  outcome: "fixed",
  summary: "New pads and rotors, bedded in on the way home.",
  followUp: "Re-check pad wear at the next oil change.",
  symptomId: 5,
  symptomTitle: "Pulsating brake pedal",
  checklistId: 7,
  checklistTitle: "Front brake job",
  sources: [
    { id: 101, documentId: 42, documentTitle: "Brake Service Guide", pageNumber: 4 },
    { id: 102, documentId: null, documentTitle: "Retired Torque Sheet", pageNumber: 9 },
  ],
  sourceCount: 2,
  createdAt: "2026-08-21 09:00:00",
  updatedAt: "2026-08-21 09:00:00",
};

// Everything optional left empty or unlinked, so the "nothing recorded" wording
// is exercised rather than assumed.
const OIL_CHANGE = {
  id: 12,
  performedOn: "2026-06-02",
  odometerMiles: null,
  title: "Oil change",
  outcome: "unknown",
  summary: "",
  followUp: "",
  symptomId: null,
  symptomTitle: "",
  checklistId: null,
  checklistTitle: "",
  sources: [],
  sourceCount: 0,
  createdAt: "2026-06-02 10:00:00",
  updatedAt: "2026-06-02 10:00:00",
};

const HISTORY = [BRAKE_JOB, OIL_CHANGE];

function stubHistory(payload = { repairHistory: HISTORY, total: HISTORY.length }, ok = true) {
  const fetchMock = vi.fn((url) => {
    if (String(url) === "/api/repair-history") {
      return jsonResponse(payload, ok);
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

async function renderHistory(entry = "/repair-history", options = {}) {
  const fetchMock = stubHistory(options.payload, options.ok);

  render(
    <MemoryRouter initialEntries={[entry]}>
      <RepairHistoryPage />
    </MemoryRouter>
  );

  if (options.expectEmpty) {
    // Said twice on purpose, matching Repair Checklists: once by the library
    // counter and once by the list itself.
    await screen.findAllByText("No repairs recorded yet.");
  } else if (options.ok !== false) {
    await screen.findByRole("heading", { level: 2, name: options.expectHeading || "Front brake job" });
  }

  return fetchMock;
}

// The detail panel is the second place a title appears (the list row is the
// first), so scope queries to it rather than matching whichever comes first.
function detailPanel() {
  return screen.getByRole("heading", { level: 2 }).closest("section");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("renders the page under its canonical heading", async () => {
  await renderHistory();

  expect(screen.getByRole("heading", { level: 1, name: "Repair History" })).toBeInTheDocument();
});

test("lists every recorded repair in the order the server sent", async () => {
  await renderHistory();

  const rows = screen.getAllByRole("button", { name: /^Select repair:/ });

  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveAccessibleName("Select repair: Front brake job");
  expect(rows[1]).toHaveAccessibleName("Select repair: Oil change");
  expect(screen.getByText("2 repairs in your library.")).toBeInTheDocument();
});

test("shows the performed date as a calendar date, not a timestamp", async () => {
  await renderHistory();

  const row = screen.getByRole("button", { name: "Select repair: Front brake job" });

  expect(within(row).getByText("Aug 20, 2026")).toBeInTheDocument();
  expect(within(row).queryByText(/\d{4}-\d{2}-\d{2}/)).not.toBeInTheDocument();
});

test("formats the odometer, and says so when there is no reading", async () => {
  await renderHistory();

  const brakeRow = screen.getByRole("button", { name: "Select repair: Front brake job" });
  const oilRow = screen.getByRole("button", { name: "Select repair: Oil change" });

  expect(within(brakeRow).getByText("183,456 mi")).toBeInTheDocument();
  // Never a bare `null`, and never a fabricated zero.
  expect(within(oilRow).getByText("Not recorded")).toBeInTheDocument();
  expect(within(oilRow).queryByText("0 mi")).not.toBeInTheDocument();
});

test("labels outcomes in words rather than as stored tokens", async () => {
  await renderHistory();

  const brakeRow = screen.getByRole("button", { name: "Select repair: Front brake job" });
  const oilRow = screen.getByRole("button", { name: "Select repair: Oil change" });

  expect(within(brakeRow).getByText("Fixed")).toBeInTheDocument();
  expect(within(oilRow).getByText("Unknown")).toBeInTheDocument();
  expect(screen.queryByText("not_fixed")).not.toBeInTheDocument();
});

test("explains the empty state in terms of how repair history gets written", async () => {
  await renderHistory("/repair-history", {
    payload: { repairHistory: [], total: 0 },
    expectEmpty: true,
  });

  expect(screen.getAllByText("No repairs recorded yet.")).toHaveLength(2);
  expect(screen.getByText(/completing a checklist/i)).toBeInTheDocument();
  expect(screen.getByText(/Record completed repair/)).toBeInTheDocument();
});

test("reports a failed load instead of rendering an empty library", async () => {
  await renderHistory("/repair-history", {
    payload: { error: "Could not load repair history." },
    ok: false,
  });

  const alert = await screen.findByRole("alert");

  expect(alert).toHaveTextContent("Could not load repair history.");
  expect(screen.queryByRole("button", { name: /^Select repair:/ })).not.toBeInTheDocument();
  // An error is not an empty list: the library counter must not claim zero.
  expect(screen.queryByText(/repairs in your library/)).not.toBeInTheDocument();
});

test("opens the repair the URL names", async () => {
  await renderHistory("/repair-history?repairHistoryId=12", { expectHeading: "Oil change" });

  expect(screen.getByRole("heading", { level: 2, name: "Oil change" })).toBeInTheDocument();
});

test("falls back to the newest repair for an id that names nothing", async () => {
  // 404 is a well-formed id for a record that is not there; the rest are shapes
  // `readIdParam` refuses outright. Neither may throw, and neither may leave the
  // panel blank.
  for (const badId of ["404", "abc", "0", "-3", "2.5", "1e3"]) {
    stubHistory();

    const { unmount } = render(
      <MemoryRouter initialEntries={[`/repair-history?repairHistoryId=${badId}`]}>
        <RepairHistoryPage />
      </MemoryRouter>
    );

    expect(
      await screen.findByRole("heading", { level: 2, name: "Front brake job" })
    ).toBeInTheDocument();

    unmount();
  }
});

test("selecting a repair writes it into the URL", async () => {
  await renderHistory();

  fireEvent.click(screen.getByRole("button", { name: "Select repair: Oil change" }));

  await waitFor(() =>
    expect(screen.getByRole("heading", { level: 2, name: "Oil change" })).toBeInTheDocument()
  );
});

test("shows the symptom snapshot and links through while the symptom exists", async () => {
  await renderHistory();

  const panel = detailPanel();

  expect(within(panel).getByText("Pulsating brake pedal")).toBeInTheDocument();
  expect(
    within(panel).getByRole("link", { name: "Open symptom Pulsating brake pedal" })
  ).toHaveAttribute("href", "/symptoms?symptomId=5#symptom-library");
});

test("shows the checklist snapshot and links through while the checklist exists", async () => {
  await renderHistory();

  const panel = detailPanel();

  expect(
    within(panel).getByRole("link", { name: "Open checklist Front brake job" })
  ).toHaveAttribute("href", "/repair-checklists?checklistId=7#checklist-library");
});

test("keeps a snapshot readable with no live link once the record is gone", async () => {
  const deletedLinks = {
    ...BRAKE_JOB,
    symptomId: null,
    checklistId: null,
    symptomTitle: "Pulsating brake pedal",
    checklistTitle: "Front brake job",
  };

  await renderHistory("/repair-history", {
    payload: { repairHistory: [deletedLinks], total: 1 },
  });

  const panel = detailPanel();

  // The historical name survives...
  expect(within(panel).getByText("Pulsating brake pedal")).toBeInTheDocument();
  // ...without pretending the live record is still there.
  expect(
    within(panel).queryByRole("link", { name: /Open symptom/ })
  ).not.toBeInTheDocument();
  expect(within(panel).queryByRole("link", { name: /Open checklist/ })).not.toBeInTheDocument();
  expect(within(panel).getAllByText(/No longer in your workspace/).length).toBeGreaterThan(0);
});

test("says plainly when no symptom or checklist was recorded", async () => {
  await renderHistory("/repair-history?repairHistoryId=12", { expectHeading: "Oil change" });

  const panel = detailPanel();

  expect(within(panel).getByText("No symptom linked")).toBeInTheDocument();
  expect(within(panel).getByText("No checklist recorded")).toBeInTheDocument();
});

test("opens a live source at its cited page through the trusted document link", async () => {
  await renderHistory();

  const panel = detailPanel();
  const openLink = within(panel).getByRole("link", {
    name: "Open Brake Service Guide at page 4 (PDF opens in a new tab)",
  });

  expect(openLink).toHaveAttribute("href", "/api/documents/42/file#page=4");
  expect(openLink).toHaveAttribute("target", "_blank");
  expect(openLink).toHaveAttribute("rel", "noopener noreferrer");
  // The page stays visible for a viewer that ignores the #page fragment.
  expect(within(panel).getByText("Page 4")).toBeInTheDocument();
});

test("keeps a deleted source's title and page but renders no broken link", async () => {
  await renderHistory();

  const panel = detailPanel();

  expect(within(panel).getByText("Retired Torque Sheet")).toBeInTheDocument();
  expect(within(panel).getByText("Page 9")).toBeInTheDocument();
  expect(
    within(panel).queryByRole("link", { name: /Open Retired Torque Sheet/ })
  ).not.toBeInTheDocument();
  expect(within(panel).getByText(/no longer in your library/i)).toBeInTheDocument();
});

test("never exposes retrieval-internal identity as provenance", async () => {
  await renderHistory();

  const panel = detailPanel();

  // Source ids, chunk ids, embedding ids, and plan run ids are deliberately not
  // durable provenance -- none of them can be resolved weeks later, which is
  // exactly when a repair history is read.
  for (const forbidden of [/sourceId/i, /chunk/i, /embedding/i, /\bS1\b/, /run id/i]) {
    expect(panel.textContent).not.toMatch(forbidden);
  }
});

test("shows what was done and what is left to do", async () => {
  await renderHistory();

  const panel = detailPanel();

  expect(
    within(panel).getByText("New pads and rotors, bedded in on the way home.")
  ).toBeInTheDocument();
  expect(
    within(panel).getByText("Re-check pad wear at the next oil change.")
  ).toBeInTheDocument();
});

test("does not offer a form for inventing a repair record by hand", async () => {
  await renderHistory();

  // N3.3 is a read surface: the creation workflow is completing a checklist,
  // which is what carries the evidence. A hand-typed record here would be a
  // repair with no provenance at all.
  expect(screen.queryByRole("button", { name: /create repair/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /add repair/i })).not.toBeInTheDocument();
});
