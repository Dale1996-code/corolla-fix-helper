import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";

import { DocumentsPage } from "./DocumentsPage";
import { SymptomsPage } from "./SymptomsPage";
import { ProceduresPage } from "./ProceduresPage";
import { NotesPage } from "./NotesPage";
import { RepairChecklistsPage } from "./RepairChecklistsPage";
import { listDetailLayoutClasses } from "../components/ListDetailLayout";

// H6: five pages had five hand-copied split-pane wrappers that had already
// drifted (two bespoke track definitions, three plain `xl:grid-cols-2`) and all
// five clipped their list. They now share one primitive, and these tests keep
// them sharing it -- a page that reintroduces its own `xl:grid-cols-*` wrapper
// fails here rather than silently going back to a half-width table.

const DOCUMENT = {
  id: 1,
  title: "Front brake service",
  originalFilename: "brakes.pdf",
  system: "Brakes",
  subsystem: "",
  documentType: "Repair Manual",
  source: "",
  notes: "",
  isFavorite: false,
  isBookmarked: false,
  extractionStatus: "completed",
  pageCount: 4,
  tags: [],
  createdAt: "2026-05-01T08:00:00.000Z",
  updatedAt: "2026-05-01T09:00:00.000Z",
};

const SYMPTOM = {
  id: 1,
  title: "Pulsating brake pedal",
  description: "Felt under braking from highway speed.",
  suspectedCauses: "Warped rotors.",
  notes: "",
  system: "Brakes",
  status: "open",
  confidence: "medium",
  linkedDocumentIds: [],
  linkedProcedureIds: [],
  createdAt: "2026-05-01T08:00:00.000Z",
  updatedAt: "2026-05-01T09:00:00.000Z",
};

const PROCEDURE = {
  id: 1,
  title: "Replace front brake pads",
  summary: "Pad and rotor replacement.",
  steps: "1. Raise the vehicle.",
  toolsRequired: "",
  partsRequired: "",
  safetyNotes: "",
  notes: "",
  system: "Brakes",
  difficulty: "intermediate",
  confidence: "medium",
  linkedDocumentIds: [],
  linkedSymptomIds: [],
  createdAt: "2026-05-01T08:00:00.000Z",
  updatedAt: "2026-05-01T09:00:00.000Z",
};

const NOTE = {
  id: 1,
  title: "Caliper bracket torque",
  body: "79 ft-lb per the factory manual.",
  noteType: "repair_log",
  relatedEntityType: "",
  relatedEntityId: null,
  relatedEntityTitle: "",
  createdAt: "2026-05-01T08:00:00.000Z",
  updatedAt: "2026-05-01T09:00:00.000Z",
};

const CHECKLIST = {
  id: 1,
  title: "Front brake job",
  status: "in_progress",
  description: "Replace front pads and rotors.",
  notes: "",
  items: [],
  itemCount: 0,
  doneItemCount: 0,
  createdAt: "2026-05-01T08:00:00.000Z",
  updatedAt: "2026-05-01T09:00:00.000Z",
};

// One permissive stub: these tests are about layout structure, so every page
// just needs its lists to resolve. Data fetching itself is covered by each
// page's own test file and is deliberately untouched by H6.
function stubApi() {
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const path = String(url).split("?")[0];
      const bodies = {
        "/api/documents": { documents: [DOCUMENT], total: 1 },
        "/api/symptoms": { symptoms: [SYMPTOM], total: 1 },
        "/api/procedures": { procedures: [PROCEDURE], total: 1 },
        "/api/notes": { notes: [NOTE], total: 1 },
        "/api/repair-checklists": { checklists: [CHECKLIST], total: 1 },
        "/api/settings": {
          vehicle: { year: 2009, make: "Toyota", model: "Corolla", trim: "LE", engine: "1.8L" },
          documentDefaults: { commonSystems: [], documentTypes: [] },
          ai: { hasApiKey: false },
        },
      };
      return Promise.resolve({ ok: true, json: async () => bodies[path] ?? {} });
    })
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const PAGES = [
  { name: "Documents", Page: DocumentsPage, route: "/documents", row: /front brake service/i },
  { name: "Symptoms", Page: SymptomsPage, route: "/symptoms", row: /pulsating brake pedal/i },
  { name: "Procedures", Page: ProceduresPage, route: "/procedures", row: /replace front brake pads/i },
  { name: "Notes", Page: NotesPage, route: "/notes", row: /caliper bracket torque/i },
  {
    name: "RepairChecklists",
    Page: RepairChecklistsPage,
    route: "/repair-checklists",
    row: /front brake job/i,
  },
];

test.each(PAGES)("$name uses the shared list/detail layout", async ({ Page, route, row }) => {
  stubApi();
  const { container } = render(
    <MemoryRouter initialEntries={[route]}>
      <Page />
    </MemoryRouter>
  );

  await waitFor(() => expect(screen.getAllByText(row).length).toBeGreaterThan(0));

  const splits = [...container.querySelectorAll("div.grid")].filter((el) =>
    el.className.includes(listDetailLayoutClasses.splitColumns)
  );
  expect(splits).toHaveLength(1);

  const [listPane, detailPane] = splits[0].children;
  expect(listPane.className).toContain("min-w-0");
  expect(detailPane.className).toContain(listDetailLayoutClasses.stickyDetail);
});

test.each(PAGES)("$name keeps no page-level split wrapper of its own", async ({ Page, route, row }) => {
  stubApi();
  const { container } = render(
    <MemoryRouter initialEntries={[route]}>
      <Page />
    </MemoryRouter>
  );

  await waitFor(() => expect(screen.getAllByText(row).length).toBeGreaterThan(0));

  // The old wrapper. `xl` is 1280px, which is narrower than the content box
  // these tables need, so no list/detail split may be gated on it again.
  const stale = [...container.querySelectorAll("div.grid")].filter(
    (el) => el.className.includes("xl:grid-cols") && el.children.length === 2 && el.children[0].tagName === "DIV"
  );
  expect(stale).toHaveLength(0);
});

test.each(PAGES)(
  "$name renders both the list and the detail in normal flow for narrow screens",
  async ({ Page, route, row }) => {
    stubApi();
    const { container } = render(
      <MemoryRouter initialEntries={[route]}>
        <Page />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getAllByText(row).length).toBeGreaterThan(0));

    const split = [...container.querySelectorAll("div.grid")].find((el) =>
      el.className.includes(listDetailLayoutClasses.splitColumns)
    );
    const [listPane, detailPane] = split.children;

    // Both panes are in the DOM at every width -- nothing is hidden to make the
    // layout fit -- and every class that changes their flow is breakpoint
    // prefixed, so the stacked order is the unprefixed default.
    expect(listPane.querySelector("section")).not.toBeNull();
    expect(detailPane.querySelector("section, form")).not.toBeNull();

    for (const className of detailPane.className.split(/\s+/).filter(Boolean)) {
      if (className === "min-w-0") continue;
      expect(className.startsWith(`${listDetailLayoutClasses.splitBreakpoint}:`)).toBe(true);
    }
  }
);
