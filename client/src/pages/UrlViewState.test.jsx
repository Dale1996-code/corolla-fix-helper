import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { buildEntityLink } from "../lib/navigation";
import { DocumentsPage } from "./DocumentsPage";
import { SymptomsPage } from "./SymptomsPage";
import { NotesPage } from "./NotesPage";
import { RepairChecklistsPage } from "./RepairChecklistsPage";
import { RepairHistoryPage } from "./RepairHistoryPage";

// H7: filters, pagination, and the selected record are query-string state, so
// the browser can restore them. These tests drive the same journey the audit
// described -- filter, page, select, leave, Back -- and assert both halves of
// the contract: the URL describes the view, and the view is rebuilt from a URL.

function jsonResponse(payload, ok = true) {
  return Promise.resolve({ ok, json: async () => payload });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// MemoryRouter keeps a real history stack, so navigate(-1)/navigate(1) exercise
// the same code path the browser's Back and Forward buttons do.
function HistoryHarness() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <div>
      <button type="button" onClick={() => navigate(-1)}>
        history back
      </button>
      <button type="button" onClick={() => navigate(1)}>
        history forward
      </button>
      <button type="button" onClick={() => navigate("/elsewhere")}>
        go elsewhere
      </button>
      <span data-testid="url">{`${location.pathname}${location.search}`}</span>
    </div>
  );
}

function currentUrl() {
  return screen.getByTestId("url").textContent;
}

function goBack() {
  fireEvent.click(screen.getByRole("button", { name: "history back" }));
}

function goForward() {
  fireEvent.click(screen.getByRole("button", { name: "history forward" }));
}

function renderPage(Page, entries) {
  return render(
    <MemoryRouter initialEntries={entries}>
      <Page />
      <HistoryHarness />
    </MemoryRouter>
  );
}

// "Page 2 of 3" is split across <span>s for its bold numbers, so match on the
// wrapper's whole text instead of on a single text node.
function expectPageIndicator(expectedText) {
  expect(
    screen.getByText(
      (_content, element) =>
        element?.tagName === "SPAN" && element.textContent.replace(/\s+/g, " ") === expectedText
    )
  ).toBeInTheDocument();
}

// --- Documents ---------------------------------------------------------------

function buildDocument(index, system) {
  const stamp = new Date(Date.UTC(2026, 0, index)).toISOString();

  return {
    id: index,
    title: `Doc ${String(index).padStart(3, "0")}`,
    originalFilename: `doc-${index}.pdf`,
    storedFilename: `doc-${index}.pdf`,
    system,
    subsystem: "",
    documentType: "Reference",
    source: "",
    notes: "",
    extractionStatus: "completed",
    pageCount: 2,
    isFavorite: false,
    isBookmarked: false,
    tags: [],
    createdAt: stamp,
    updatedAt: stamp,
  };
}

// 60 documents: 30 Brakes and 30 Engine, so a single system filter still spans
// more than one page and "page 2 of the filtered set" is a real view.
const LIBRARY = Array.from({ length: 60 }, (_, index) =>
  buildDocument(60 - index, index % 2 === 0 ? "Brakes" : "Engine")
);

function stubDocumentsFetch(documents = LIBRARY) {
  const fetchMock = vi.fn((url) => {
    if (url === "/api/documents") {
      return jsonResponse({ documents, total: documents.length });
    }

    if (url === "/api/settings") {
      return jsonResponse({ documentDefaults: { commonSystems: [], documentTypes: [] } });
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

function selectedDocumentTitle() {
  // The detail panel repeats the selected document's title as its heading.
  return screen.getByRole("heading", { level: 2, name: /^Doc \d{3}$/ }).textContent;
}

async function renderDocuments(entry = "/documents") {
  const fetchMock = stubDocumentsFetch();
  renderPage(DocumentsPage, [entry]);
  await screen.findByText("Library controls");

  return fetchMock;
}

test("Documents rebuilds filter, page, and selection from a deep link", async () => {
  await renderDocuments("/documents?system=Brakes&page=2&documentId=4");

  expect(screen.getByRole("combobox", { name: "System" })).toHaveValue("Brakes");
  expectPageIndicator("Page 2 of 2");
  expect(selectedDocumentTitle()).toBe("Doc 004");
  // The deep link is left exactly as it was handed to us -- normalizing a URL
  // that is already canonical would spend a history entry saying nothing.
  expect(currentUrl()).toBe("/documents?system=Brakes&page=2&documentId=4");
});

test("Documents opens the record a buildEntityLink deep link names, #hash and all", async () => {
  // The real shape other pages link with: "?documentId=4#document-library".
  // The trailing hash is a scroll anchor, so it must not disturb the selection.
  const link = buildEntityLink("document", 4);
  expect(link).toBe("/documents?documentId=4#document-library");

  await renderDocuments(link);

  expect(selectedDocumentTitle()).toBe("Doc 004");
  expect(currentUrl()).toBe("/documents?documentId=4");
});

test("Documents survives duplicate query keys", async () => {
  await renderDocuments("/documents?page=1&page=99&documentId=8&documentId=4");

  // URLSearchParams reads the first value of a repeated key, and nothing throws.
  expect(selectedDocumentTitle()).toBe("Doc 008");
  expectPageIndicator("Page 1 of 3");
});

test("Documents keeps a default view's URL clean", async () => {
  await renderDocuments();

  expect(currentUrl()).toBe("/documents");

  // Choosing a filter and then choosing its default back leaves no residue.
  fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), {
    target: { value: "title_asc" },
  });
  expect(currentUrl()).toBe("/documents?sort=title_asc");

  fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), {
    target: { value: "newest" },
  });
  expect(currentUrl()).toBe("/documents");
});

test("Documents writes filter, page, and selection changes into the URL", async () => {
  await renderDocuments();

  fireEvent.change(screen.getByRole("combobox", { name: "System" }), {
    target: { value: "Brakes" },
  });
  expect(currentUrl()).toBe("/documents?system=Brakes");

  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(currentUrl()).toBe("/documents?system=Brakes&page=2");

  fireEvent.click(await screen.findByRole("button", { name: "Select document: Doc 004" }));
  expect(currentUrl()).toBe("/documents?system=Brakes&page=2&documentId=4");
});

test("Documents restores the previous view on Back and the next one on Forward", async () => {
  await renderDocuments();

  fireEvent.change(screen.getByRole("combobox", { name: "System" }), {
    target: { value: "Brakes" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(await screen.findByRole("button", { name: "Select document: Doc 004" }));

  const viewedUrl = currentUrl();
  expect(viewedUrl).toBe("/documents?system=Brakes&page=2&documentId=4");
  expect(selectedDocumentTitle()).toBe("Doc 004");

  // This is the audit's reproduction: leave the list, then come back.
  fireEvent.click(screen.getByRole("button", { name: "go elsewhere" }));
  expect(currentUrl()).toBe("/elsewhere");

  goBack();
  await waitFor(() => expect(currentUrl()).toBe(viewedUrl));
  expect(screen.getByRole("combobox", { name: "System" })).toHaveValue("Brakes");
  expectPageIndicator("Page 2 of 2");
  expect(selectedDocumentTitle()).toBe("Doc 004");

  // Back again steps through the selection and the page, not over them.
  goBack();
  await waitFor(() => expect(currentUrl()).toBe("/documents?system=Brakes&page=2"));
  goBack();
  await waitFor(() => expect(currentUrl()).toBe("/documents?system=Brakes"));
  expectPageIndicator("Page 1 of 2");

  goForward();
  await waitFor(() => expect(currentUrl()).toBe("/documents?system=Brakes&page=2"));
  expectPageIndicator("Page 2 of 2");
});

test("Documents survives unusable query parameters and normalizes them once", async () => {
  await renderDocuments("/documents?page=abc&documentId=not-a-number&sort=sideways&keep=me");

  // Nothing throws, every unusable value falls back to its default, and the
  // parameter this page knows nothing about is left alone.
  expect(screen.getByRole("combobox", { name: "Sort" })).toHaveValue("newest");
  expectPageIndicator("Page 1 of 3");
  expect(selectedDocumentTitle()).toBe("Doc 060");

  // The unusable selection is cleared; the unknown `sort` value and the
  // parameter this page knows nothing about are both carried through.
  await waitFor(() => expect(currentUrl()).toBe("/documents?sort=sideways&keep=me"));
});

test("Documents clamps a page past the end of the filtered results", async () => {
  await renderDocuments("/documents?system=Brakes&page=9");

  await waitFor(() => expect(currentUrl()).toBe("/documents?system=Brakes&page=2"));
  expectPageIndicator("Page 2 of 2");
});

test("Documents drops a selection for a document that is not there, keeping list state", async () => {
  await renderDocuments("/documents?system=Brakes&page=2&documentId=9999");

  // Only the selection is invalid, so only the selection is cleared.
  await waitFor(() => expect(currentUrl()).toBe("/documents?system=Brakes&page=2"));
  expect(screen.getByRole("combobox", { name: "System" })).toHaveValue("Brakes");
  expectPageIndicator("Page 2 of 2");
});

test("Documents narrowed by a filter falls back to the first page", async () => {
  await renderDocuments("/documents?page=3");

  expectPageIndicator("Page 3 of 3");

  fireEvent.change(screen.getByRole("combobox", { name: "System" }), {
    target: { value: "Brakes" },
  });

  // Page 3 of the whole library says nothing about the Brakes-only list.
  expect(currentUrl()).toBe("/documents?system=Brakes");
  expectPageIndicator("Page 1 of 2");
});

test("Documents does not refetch when filters, pages, or the selection change", async () => {
  const fetchMock = await renderDocuments();

  const documentRequests = () =>
    fetchMock.mock.calls.filter(([url]) => url === "/api/documents").length;

  expect(documentRequests()).toBe(1);

  fireEvent.change(screen.getByRole("combobox", { name: "System" }), {
    target: { value: "Brakes" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(await screen.findByRole("button", { name: "Select document: Doc 004" }));
  goBack();
  await waitFor(() => expect(currentUrl()).toBe("/documents?system=Brakes&page=2"));

  // The library is loaded once; the URL only decides how it is sliced.
  expect(documentRequests()).toBe(1);
});

// --- Symptoms ----------------------------------------------------------------

const SYMPTOMS = [
  {
    id: 11,
    title: "Rough idle",
    description: "Shakes at stops",
    system: "Engine",
    suspectedCauses: "",
    confidence: "high",
    status: "open",
    notes: "",
    createdAt: "2026-03-03T10:00:00.000Z",
    updatedAt: "2026-03-03T10:00:00.000Z",
    linkedDocumentIds: [],
    linkedDocuments: [],
    linkedProcedureIds: [],
    linkedProcedures: [],
  },
  {
    id: 12,
    title: "Brake squeal",
    description: "Squeals when cold",
    system: "Brakes",
    suspectedCauses: "",
    confidence: "medium",
    status: "resolved",
    notes: "",
    createdAt: "2026-03-02T10:00:00.000Z",
    updatedAt: "2026-03-02T10:00:00.000Z",
    linkedDocumentIds: [],
    linkedDocuments: [],
    linkedProcedureIds: [],
    linkedProcedures: [],
  },
];

function stubSymptomsFetch(symptoms = SYMPTOMS) {
  const fetchMock = vi.fn((url) => {
    if (url === "/api/symptoms") return jsonResponse({ symptoms, total: symptoms.length });
    if (url === "/api/documents") return jsonResponse({ documents: [], total: 0 });
    if (url === "/api/procedures") return jsonResponse({ procedures: [], total: 0 });
    if (url === "/api/settings") {
      return jsonResponse({ documentDefaults: { commonSystems: [], documentTypes: [] } });
    }
    if (url.startsWith("/api/attachments")) {
      return jsonResponse({ attachments: [], total: 0 });
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

async function renderSymptoms(entry = "/symptoms", entries = [entry]) {
  const fetchMock = stubSymptomsFetch();
  renderPage(SymptomsPage, entries);
  await screen.findByRole("combobox", { name: "Status filter" });

  return fetchMock;
}

function selectedSymptomTitle() {
  return screen.getByRole("heading", { level: 2, name: /Rough idle|Brake squeal/ }).textContent;
}

test("Symptoms rebuilds its filters and selection from a deep link", async () => {
  await renderSymptoms("/symptoms?status=resolved&symptomId=12");

  expect(screen.getByRole("combobox", { name: "Status filter" })).toHaveValue("resolved");
  expect(selectedSymptomTitle()).toBe("Brake squeal");
});

test("Symptoms writes filter and selection changes into the URL and Back undoes them", async () => {
  await renderSymptoms();

  expect(currentUrl()).toBe("/symptoms");

  fireEvent.change(screen.getByRole("combobox", { name: "Status filter" }), {
    target: { value: "resolved" },
  });
  expect(currentUrl()).toBe("/symptoms?status=resolved");
  expect(selectedSymptomTitle()).toBe("Brake squeal");

  goBack();
  await waitFor(() => expect(currentUrl()).toBe("/symptoms"));
  expect(screen.getByRole("combobox", { name: "Status filter" })).toHaveValue("all");
  expect(selectedSymptomTitle()).toBe("Rough idle");

  goForward();
  await waitFor(() => expect(currentUrl()).toBe("/symptoms?status=resolved"));
  expect(selectedSymptomTitle()).toBe("Brake squeal");
});

test("Symptoms commits the keyword box without a history entry per keystroke", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });

  try {
    // A prior entry to fall back to, so "one Back leaves the page" is provable
    // rather than a no-op at the bottom of the history stack.
    await renderSymptoms("/symptoms", ["/elsewhere", "/symptoms"]);

    const searchBox = screen.getByPlaceholderText(
      "Search title, system, causes, or notes"
    );

    // Typing filters the list straight away, exactly as it did before the URL
    // held this state...
    fireEvent.change(searchBox, { target: { value: "bra" } });
    fireEvent.change(searchBox, { target: { value: "brake" } });
    expect(selectedSymptomTitle()).toBe("Brake squeal");
    expect(currentUrl()).toBe("/symptoms");

    // ...and lands in the URL once, after the typing stops.
    await vi.advanceTimersByTimeAsync(400);
    await waitFor(() => expect(currentUrl()).toBe("/symptoms?q=brake"));

    // It replaced rather than pushed, so a single Back leaves the page instead
    // of walking backwards through "brake", "brak", "bra", "br", "b".
    goBack();
    await waitFor(() => expect(currentUrl()).toBe("/elsewhere"));
  } finally {
    vi.useRealTimers();
  }
});

test("Symptoms ignores an unusable symptomId and clears it from the URL", async () => {
  await renderSymptoms("/symptoms?symptomId=abc&status=resolved");

  // "abc" is no selection at all, so the page shows the filtered default...
  expect(selectedSymptomTitle()).toBe("Brake squeal");

  // ...and the parameter is cleared rather than left claiming a record that
  // does not exist. The status filter beside it is untouched.
  await waitFor(() => expect(currentUrl()).toBe("/symptoms?status=resolved"));
  expect(screen.getByRole("combobox", { name: "Status filter" })).toHaveValue("resolved");
});

test("Symptoms drops a selection for a symptom that no longer exists", async () => {
  await renderSymptoms("/symptoms?system=Engine&symptomId=999");

  await waitFor(() => expect(currentUrl()).toBe("/symptoms?system=Engine"));
  expect(screen.getByRole("combobox", { name: "System filter" })).toHaveValue("Engine");
  expect(selectedSymptomTitle()).toBe("Rough idle");
});

// --- Notes -------------------------------------------------------------------

const NOTES = [
  {
    id: 21,
    title: "Coolant top-up",
    content: "Added coolant",
    noteType: "maintenance",
    relatedEntityType: "none",
    relatedEntityId: null,
    createdAt: "2026-02-02T10:00:00.000Z",
    updatedAt: "2026-02-02T10:00:00.000Z",
  },
  {
    id: 22,
    title: "Odd smell",
    content: "Burning smell after driving",
    noteType: "observation",
    relatedEntityType: "none",
    relatedEntityId: null,
    createdAt: "2026-02-01T10:00:00.000Z",
    updatedAt: "2026-02-01T10:00:00.000Z",
  },
];

async function renderNotes(entry = "/notes") {
  const fetchMock = vi.fn((url) => {
    if (url === "/api/notes") return jsonResponse({ notes: NOTES, total: NOTES.length });
    if (url === "/api/documents") return jsonResponse({ documents: [], total: 0 });
    if (url === "/api/symptoms") return jsonResponse({ symptoms: [], total: 0 });
    if (url === "/api/procedures") return jsonResponse({ procedures: [], total: 0 });
    if (url.startsWith("/api/attachments")) return jsonResponse({ attachments: [], total: 0 });

    throw new Error(`Unexpected fetch call: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);
  renderPage(NotesPage, [entry]);
  await screen.findByRole("combobox", { name: "Linked item" });

  return fetchMock;
}

test("Notes rebuilds its filter and selection from a deep link", async () => {
  await renderNotes("/notes?noteType=observation&noteId=22");

  // The create form carries a "Note type" field of its own; the filter is the
  // one alongside the "Linked item" filter.
  const noteFilters = within(
    screen.getByRole("combobox", { name: "Linked item" }).closest("section")
  );
  expect(noteFilters.getByRole("combobox", { name: "Note type" })).toHaveValue("observation");
  expect(
    screen.getByRole("heading", { level: 2, name: "Odd smell" })
  ).toBeInTheDocument();
});

test("Notes writes selection to the URL and Back returns to the previous note", async () => {
  await renderNotes();

  expect(currentUrl()).toBe("/notes");
  expect(screen.getByRole("heading", { level: 2, name: "Coolant top-up" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /Select note: Odd smell/ }));
  expect(currentUrl()).toBe("/notes?noteId=22");
  expect(screen.getByRole("heading", { level: 2, name: "Odd smell" })).toBeInTheDocument();

  goBack();
  await waitFor(() => expect(currentUrl()).toBe("/notes"));
  expect(screen.getByRole("heading", { level: 2, name: "Coolant top-up" })).toBeInTheDocument();
});

// --- Repair Checklists -------------------------------------------------------

const CHECKLISTS = [
  {
    id: 31,
    title: "Front brake job",
    status: "planned",
    description: "",
    notes: "",
    createdAt: "2026-05-02T08:00:00.000Z",
    updatedAt: "2026-05-02T09:00:00.000Z",
    items: [],
    itemCount: 0,
    doneItemCount: 0,
  },
  {
    id: 32,
    title: "Oil change",
    status: "planned",
    description: "",
    notes: "",
    createdAt: "2026-05-01T08:00:00.000Z",
    updatedAt: "2026-05-01T09:00:00.000Z",
    items: [],
    itemCount: 0,
    doneItemCount: 0,
  },
];

async function renderChecklists(entry = "/repair-checklists") {
  const fetchMock = vi.fn((url, options = {}) => {
    if (url === "/api/repair-checklists" && (!options.method || options.method === "GET")) {
      return jsonResponse({ checklists: CHECKLISTS, total: CHECKLISTS.length });
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);
  renderPage(RepairChecklistsPage, [entry]);
  await screen.findByRole("heading", { level: 2, name: "Front brake job" });

  return fetchMock;
}

test("Repair Checklists puts the open checklist in the URL and Back reopens the previous one", async () => {
  await renderChecklists();

  expect(currentUrl()).toBe("/repair-checklists");

  fireEvent.click(screen.getByRole("button", { name: "Select checklist: Oil change" }));
  expect(currentUrl()).toBe("/repair-checklists?checklistId=32");
  expect(screen.getByRole("heading", { level: 2, name: "Oil change" })).toBeInTheDocument();

  goBack();
  await waitFor(() => expect(currentUrl()).toBe("/repair-checklists"));
  expect(screen.getByRole("heading", { level: 2, name: "Front brake job" })).toBeInTheDocument();
});

test("Repair Checklists clears a checklistId that names nothing", async () => {
  await renderChecklists("/repair-checklists?checklistId=404");

  // The newest checklist is shown in its place, and the URL stops claiming
  // otherwise.
  expect(screen.getByRole("heading", { level: 2, name: "Front brake job" })).toBeInTheDocument();
  await waitFor(() => expect(currentUrl()).toBe("/repair-checklists"));
});


// --- Repair History ----------------------------------------------------------

const REPAIRS = [
  {
    id: 91,
    performedOn: "2026-08-20",
    odometerMiles: 183456,
    title: "Front brake job",
    outcome: "fixed",
    summary: "New pads and rotors.",
    followUp: "",
    symptomId: null,
    symptomTitle: "",
    checklistId: null,
    checklistTitle: "",
    sources: [],
    sourceCount: 0,
    createdAt: "2026-08-21 09:00:00",
    updatedAt: "2026-08-21 09:00:00",
  },
  {
    id: 92,
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
  },
];

async function renderRepairHistory(entry = "/repair-history") {
  const fetchMock = vi.fn((url) => {
    if (url === "/api/repair-history") {
      return jsonResponse({ repairHistory: REPAIRS, total: REPAIRS.length });
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);
  renderPage(RepairHistoryPage, [entry]);
  await screen.findByRole("heading", { level: 2, name: /Front brake job|Oil change/ });

  return fetchMock;
}

test("Repair History puts the open repair in the URL and Back reopens the previous one", async () => {
  await renderRepairHistory();

  expect(currentUrl()).toBe("/repair-history");

  fireEvent.click(screen.getByRole("button", { name: "Select repair: Oil change" }));
  expect(currentUrl()).toBe("/repair-history?repairHistoryId=92");
  expect(screen.getByRole("heading", { level: 2, name: "Oil change" })).toBeInTheDocument();

  goBack();
  await waitFor(() => expect(currentUrl()).toBe("/repair-history"));
  expect(screen.getByRole("heading", { level: 2, name: "Front brake job" })).toBeInTheDocument();

  goForward();
  await waitFor(() => expect(currentUrl()).toBe("/repair-history?repairHistoryId=92"));
  expect(screen.getByRole("heading", { level: 2, name: "Oil change" })).toBeInTheDocument();
});

test("Repair History rebuilds a selection from a deep link", async () => {
  await renderRepairHistory("/repair-history?repairHistoryId=92");

  expect(screen.getByRole("heading", { level: 2, name: "Oil change" })).toBeInTheDocument();
  // A deep link is already the view it describes; nothing is rewritten.
  expect(currentUrl()).toBe("/repair-history?repairHistoryId=92");
});

test("Repair History clears a repairHistoryId that names nothing", async () => {
  await renderRepairHistory("/repair-history?repairHistoryId=404");

  // The newest repair is shown in its place, and the URL stops claiming
  // otherwise.
  expect(screen.getByRole("heading", { level: 2, name: "Front brake job" })).toBeInTheDocument();
  await waitFor(() => expect(currentUrl()).toBe("/repair-history"));
});

test("Repair History survives a hand-typed repairHistoryId that is not an id at all", async () => {
  await renderRepairHistory("/repair-history?repairHistoryId=%2Fetc%2Fpasswd");

  expect(screen.getByRole("heading", { level: 2, name: "Front brake job" })).toBeInTheDocument();
  await waitFor(() => expect(currentUrl()).toBe("/repair-history"));
});

test("Repair History does not refetch when the selection changes", async () => {
  const fetchMock = await renderRepairHistory();

  const callsAfterLoad = fetchMock.mock.calls.length;

  fireEvent.click(screen.getByRole("button", { name: "Select repair: Oil change" }));
  goBack();
  await waitFor(() => expect(currentUrl()).toBe("/repair-history"));

  // Selection is derived from data already in hand -- a URL change here is a
  // re-render, not a request.
  expect(fetchMock.mock.calls.length).toBe(callsAfterLoad);
});
