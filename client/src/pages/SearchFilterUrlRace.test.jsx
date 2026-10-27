import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProceduresPage } from "./ProceduresPage";
import { SymptomsPage } from "./SymptomsPage";
import { buildSymptom, createSymptomsApi, jsonResponse } from "../test/symptomsApiMock";

// Issue #164 on the two pages that have a keyword box: the box's debounced URL
// commit and a filter change in the same moment must both survive, in either
// order, and the box, the URL, and the list must agree afterwards.
//
// Fake timers throughout, and "the same moment" is exact: the debounce firing
// and the filter's change event sit inside ONE act(), so React renders nothing
// between them. No assertion depends on how fast the machine is.

const DEBOUNCE_MS = 300;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Harness() {
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
      <span data-testid="url">{`${location.pathname}${location.search}`}</span>
    </div>
  );
}

function currentUrl() {
  return screen.getByTestId("url").textContent;
}

function currentParams() {
  return Object.fromEntries(new URL(currentUrl(), "http://x").searchParams);
}

// Lets resolved fetches and the state updates they cause land, without moving
// the clock.
async function settle() {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

async function tick(ms) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function typeKeyword(label, value) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

// ---------------------------------------------------------------- Symptoms --

const SYMPTOMS = Array.from({ length: 60 }, (_, index) =>
  buildSymptom(index + 1, {
    title: index % 2 === 0 ? `Brake noise ${index + 1}` : `Idle surge ${index + 1}`,
    system: index % 2 === 0 ? "Brakes" : "Engine",
    status: ["open", "monitoring", "resolved"][index % 3],
  })
);

async function renderSymptoms(entry = "/symptoms") {
  const api = createSymptomsApi({ symptoms: SYMPTOMS, documents: [], procedures: [] });
  vi.stubGlobal("fetch", vi.fn(api.fetch));

  render(
    <MemoryRouter initialEntries={[entry]}>
      <SymptomsPage />
      <Harness />
    </MemoryRouter>
  );
  await settle();

  return api;
}

function symptomRowCount() {
  return screen.queryAllByTestId("symptom-row-title").length;
}

// What the list on screen was last asked for.
function lastListRequest(api) {
  return Object.fromEntries(api.listRequests.at(-1));
}

describe("Symptoms: keyword commit and filter change in the same moment", () => {
  test("the debounce fires first, then Status changes: keyword and status both land", async () => {
    const api = await renderSymptoms();

    typeKeyword("Search", "brake");
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
      fireEvent.change(screen.getByLabelText("Status filter"), { target: { value: "open" } });
    });
    await settle();

    expect(currentParams()).toEqual({ q: "brake", status: "open" });
    expect(screen.getByLabelText("Search")).toHaveValue("brake");
    expect(screen.getByLabelText("Status filter")).toHaveValue("open");
    // The list is filtered by both, not just one.
    expect(lastListRequest(api)).toMatchObject({ q: "brake", status: "open" });
    expect(symptomRowCount()).toBeGreaterThan(0);
  });

  test("Status changes first, then the debounce fires: keyword and status both land", async () => {
    const api = await renderSymptoms();

    typeKeyword("Search", "brake");
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Status filter"), { target: { value: "open" } });
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    await settle();

    expect(currentParams()).toEqual({ q: "brake", status: "open" });
    expect(screen.getByLabelText("Search")).toHaveValue("brake");
    expect(lastListRequest(api)).toMatchObject({ q: "brake", status: "open" });
  });

  test("a search box that still shows the keyword is never left unfiltered", async () => {
    const api = await renderSymptoms();

    typeKeyword("Search", "brake");
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
      fireEvent.change(screen.getByLabelText("Status filter"), { target: { value: "open" } });
    });
    await tick(5 * DEBOUNCE_MS);
    await settle();

    expect(screen.getByLabelText("Search")).toHaveValue("brake");
    expect(currentParams().q).toBe("brake");
    expect(lastListRequest(api).q).toBe("brake");
  });

  test("the keyword commit drops the page, and a filter in the same moment keeps that", async () => {
    const api = await renderSymptoms("/symptoms?page=2&system=Brakes");

    typeKeyword("Search", "brake");
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
      fireEvent.change(screen.getByLabelText("Status filter"), { target: { value: "open" } });
    });
    await settle();

    expect(currentParams()).toEqual({ system: "Brakes", q: "brake", status: "open" });
    expect(lastListRequest(api)).toMatchObject({ offset: "0", q: "brake", status: "open" });
  });

  test("rapid filter changes around the commit all land", async () => {
    const api = await renderSymptoms();

    typeKeyword("Search", "brake");
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Status filter"), { target: { value: "open" } });
      fireEvent.change(screen.getByLabelText("System filter"), { target: { value: "Brakes" } });
      vi.advanceTimersByTime(DEBOUNCE_MS);
      fireEvent.change(screen.getByLabelText("Sort order"), { target: { value: "title" } });
    });
    await settle();

    expect(currentParams()).toEqual({
      status: "open",
      system: "Brakes",
      q: "brake",
      sort: "title",
    });
    expect(lastListRequest(api)).toMatchObject({
      q: "brake",
      status: "open",
      system: "Brakes",
      sort: "title",
    });
  });

  test("a filter change 1 ms before and 1 ms after the commit both keep the keyword", async () => {
    await renderSymptoms();

    typeKeyword("Search", "brake");
    await tick(DEBOUNCE_MS - 1);
    fireEvent.change(screen.getByLabelText("Status filter"), { target: { value: "open" } });
    await tick(1);
    await settle();
    expect(currentParams()).toEqual({ status: "open", q: "brake" });

    fireEvent.change(screen.getByLabelText("System filter"), { target: { value: "Brakes" } });
    await settle();
    expect(currentParams()).toEqual({ status: "open", q: "brake", system: "Brakes" });
  });

  test("clearing the keyword keeps the active filters", async () => {
    const api = await renderSymptoms("/symptoms?q=brake&status=open");

    expect(screen.getByLabelText("Search")).toHaveValue("brake");
    typeKeyword("Search", "");
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
      fireEvent.change(screen.getByLabelText("System filter"), { target: { value: "Brakes" } });
    });
    await settle();

    expect(currentParams()).toEqual({ status: "open", system: "Brakes" });
    expect(screen.getByLabelText("Search")).toHaveValue("");
    expect(lastListRequest(api).q).toBeUndefined();
  });
});

describe("Symptoms: history, refresh, and stale responses", () => {
  test("Back and Forward restore the URL and the controls together", async () => {
    await renderSymptoms();

    fireEvent.change(screen.getByLabelText("Status filter"), { target: { value: "open" } });
    typeKeyword("Search", "brake");
    await tick(DEBOUNCE_MS);
    await settle();
    expect(currentParams()).toEqual({ status: "open", q: "brake" });

    fireEvent.click(screen.getByRole("button", { name: "history back" }));
    await settle();
    expect(currentUrl()).toBe("/symptoms");
    expect(screen.getByLabelText("Search")).toHaveValue("");
    expect(screen.getByLabelText("Status filter")).toHaveValue("all");

    fireEvent.click(screen.getByRole("button", { name: "history forward" }));
    await settle();
    expect(currentParams()).toEqual({ status: "open", q: "brake" });
    expect(screen.getByLabelText("Search")).toHaveValue("brake");
    expect(screen.getByLabelText("Status filter")).toHaveValue("open");
  });

  test("a refresh or pasted link rebuilds the box, filters, and list, and keeps the link", async () => {
    const api = await renderSymptoms("/symptoms?q=brake&status=open&symptomId=3");

    expect(screen.getByLabelText("Search")).toHaveValue("brake");
    expect(screen.getByLabelText("Status filter")).toHaveValue("open");
    expect(lastListRequest(api)).toMatchObject({ q: "brake", status: "open" });

    // Quiet time changes nothing, and a later filter keeps the selection too.
    await tick(5 * DEBOUNCE_MS);
    expect(currentParams()).toEqual({ q: "brake", status: "open", symptomId: "3" });
    fireEvent.change(screen.getByLabelText("System filter"), { target: { value: "Brakes" } });
    await settle();
    expect(currentParams()).toEqual({
      q: "brake",
      status: "open",
      symptomId: "3",
      system: "Brakes",
    });
  });

  test("a slow answer to the old view never replaces the newer one", async () => {
    const held = [];
    const api = createSymptomsApi(
      { symptoms: SYMPTOMS, documents: [], procedures: [] },
      {
        extra: (url, init, state) =>
          url.startsWith("/api/symptoms?") && url.includes("q=brake") && !url.includes("status=")
            ? new Promise((resolve) => held.push(() => resolve(state.route(url, init))))
            : undefined,
      }
    );
    vi.stubGlobal("fetch", vi.fn(api.fetch));
    render(
      <MemoryRouter initialEntries={["/symptoms"]}>
        <SymptomsPage />
        <Harness />
      </MemoryRouter>
    );
    await settle();

    // The keyword-only view is requested, and is slow...
    typeKeyword("Search", "brake");
    await tick(DEBOUNCE_MS);
    await settle();
    expect(held).toHaveLength(1);

    // ...and the owner moves on to keyword + status before it answers.
    fireEvent.change(screen.getByLabelText("Status filter"), { target: { value: "open" } });
    await settle();
    const rowsForNewView = symptomRowCount();
    expect(lastListRequest(api)).toMatchObject({ q: "brake", status: "open" });

    held.shift()();
    await settle();

    expect(symptomRowCount()).toBe(rowsForNewView);
    expect(currentParams()).toEqual({ q: "brake", status: "open" });
    expect(
      screen
        .getAllByTestId("symptom-row-title")
        .every((node) => node.textContent.startsWith("Brake noise"))
    ).toBe(true);
  });

  test("one keyword commit is one list request", async () => {
    const api = await renderSymptoms();
    const before = api.listRequests.length;

    typeKeyword("Search", "brake");
    await tick(5 * DEBOUNCE_MS);
    await settle();

    expect(api.listRequests.length - before).toBe(1);
  });
});

// -------------------------------------------------------------- Procedures --

function buildProcedure(id, overrides = {}) {
  return {
    id,
    title: `Procedure ${id}`,
    system: "Engine",
    difficulty: "beginner",
    toolsNeeded: "",
    partsNeeded: "",
    safetyNotes: "",
    steps: "Do the work.",
    notes: "",
    confidence: "medium",
    createdAt: `2026-04-${String(10 + id).padStart(2, "0")}T10:00:00.000Z`,
    updatedAt: `2026-04-${String(10 + id).padStart(2, "0")}T12:00:00.000Z`,
    linkedDocumentIds: [],
    linkedDocuments: [],
    ...overrides,
  };
}

const PROCEDURES = [
  buildProcedure(1, { title: "Front brake pad swap", system: "Brakes", difficulty: "beginner" }),
  buildProcedure(2, { title: "Rear brake pad swap", system: "Brakes", difficulty: "advanced" }),
  buildProcedure(3, { title: "Throttle body cleaning", system: "Engine", difficulty: "beginner" }),
];

const SEARCH_LABEL = "Search title, system, tools, parts, steps, or notes";

async function renderProcedures(entry = "/procedures") {
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      if (url === "/api/procedures") {
        return jsonResponse({ procedures: PROCEDURES, total: PROCEDURES.length });
      }
      if (url === "/api/documents") {
        return jsonResponse({ documents: [], total: 0 });
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    })
  );

  render(
    <MemoryRouter initialEntries={[entry]}>
      <ProceduresPage />
      <Harness />
    </MemoryRouter>
  );
  await settle();
}

function proceduresSearchBox() {
  return screen.getByPlaceholderText(SEARCH_LABEL);
}

describe("Procedures: keyword commit and filter change in the same moment", () => {
  test("the debounce fires first, then Difficulty changes: both land", async () => {
    await renderProcedures();

    fireEvent.change(proceduresSearchBox(), { target: { value: "brake" } });
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
      fireEvent.change(screen.getByLabelText("Difficulty filter"), {
        target: { value: "beginner" },
      });
    });
    await settle();

    expect(currentParams()).toEqual({ q: "brake", difficulty: "beginner" });
    expect(proceduresSearchBox()).toHaveValue("brake");
    expect(screen.getByLabelText("Difficulty filter")).toHaveValue("beginner");
  });

  test("Difficulty changes first, then the debounce fires: both land", async () => {
    await renderProcedures();

    fireEvent.change(proceduresSearchBox(), { target: { value: "brake" } });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Difficulty filter"), {
        target: { value: "beginner" },
      });
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    await settle();

    expect(currentParams()).toEqual({ q: "brake", difficulty: "beginner" });
    expect(proceduresSearchBox()).toHaveValue("brake");
  });

  test("rapid filter changes around the commit all land, and unrelated parameters stay", async () => {
    await renderProcedures("/procedures?procedureId=1");

    fireEvent.change(proceduresSearchBox(), { target: { value: "brake" } });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Difficulty filter"), {
        target: { value: "beginner" },
      });
      vi.advanceTimersByTime(DEBOUNCE_MS);
      fireEvent.change(screen.getByLabelText("Confidence filter"), { target: { value: "medium" } });
    });
    await settle();

    expect(currentParams()).toEqual({
      procedureId: "1",
      difficulty: "beginner",
      q: "brake",
      confidence: "medium",
    });
  });

  test("clearing the keyword keeps the active filters", async () => {
    await renderProcedures("/procedures?q=brake&difficulty=beginner");

    expect(proceduresSearchBox()).toHaveValue("brake");
    fireEvent.change(proceduresSearchBox(), { target: { value: "" } });
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
      fireEvent.change(screen.getByLabelText("Confidence filter"), { target: { value: "medium" } });
    });
    await settle();

    expect(currentParams()).toEqual({ difficulty: "beginner", confidence: "medium" });
    expect(proceduresSearchBox()).toHaveValue("");
  });

  test("Back and Forward restore the URL and the controls together", async () => {
    await renderProcedures();

    fireEvent.change(screen.getByLabelText("Difficulty filter"), { target: { value: "beginner" } });
    fireEvent.change(proceduresSearchBox(), { target: { value: "brake" } });
    await tick(DEBOUNCE_MS);
    await settle();
    expect(currentParams()).toEqual({ difficulty: "beginner", q: "brake" });

    fireEvent.click(screen.getByRole("button", { name: "history back" }));
    await settle();
    expect(currentUrl()).toBe("/procedures");
    expect(proceduresSearchBox()).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "history forward" }));
    await settle();
    expect(currentParams()).toEqual({ difficulty: "beginner", q: "brake" });
    expect(proceduresSearchBox()).toHaveValue("brake");
    expect(screen.getByLabelText("Difficulty filter")).toHaveValue("beginner");
  });

  test("a pasted link rebuilds the view and keeps every parameter", async () => {
    await renderProcedures("/procedures?q=brake&difficulty=beginner&procedureId=1");

    expect(proceduresSearchBox()).toHaveValue("brake");
    expect(screen.getByLabelText("Difficulty filter")).toHaveValue("beginner");
    await tick(5 * DEBOUNCE_MS);
    expect(currentParams()).toEqual({ q: "brake", difficulty: "beginner", procedureId: "1" });
  });
});
