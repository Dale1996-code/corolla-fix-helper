import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { ProceduresPage } from "./ProceduresPage";
import { buildProcedure, createProceduresApi } from "../test/proceduresApiMock";

// The Procedures page asks the server for one filtered, ordered page at a time
// (N7), so these tests run it against a stand-in that applies the same request.
// Paging, deep links, and writes are covered in ProceduresPagination.test.jsx.
// Every record here is synthetic.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function getCountTextMatcher(expectedText) {
  return (_content, element) =>
    element?.tagName === "P" && element.textContent === expectedText;
}

const SEARCH_PLACEHOLDER = "Search title, system, tools, parts, steps, or notes";

const THROTTLE = buildProcedure(31, {
  title: "Throttle body cleaning",
  system: "Engine",
  difficulty: "beginner",
  toolsNeeded: "Socket set",
  steps: "Clean throttle plate.",
  confidence: "medium",
  createdAt: "2026-04-18T10:00:00.000Z",
  updatedAt: "2026-04-18T12:00:00.000Z",
});

const REAR_BRAKES = buildProcedure(32, {
  title: "Rear brake pad replacement",
  system: "Brakes",
  difficulty: "advanced",
  toolsNeeded: "Caliper tool",
  partsNeeded: "Brake pads",
  steps: "Service rear brakes.",
  confidence: "high",
  createdAt: "2026-04-19T10:00:00.000Z",
  updatedAt: "2026-04-19T12:00:00.000Z",
});

function renderProcedures(library, entry = "/procedures") {
  const api = createProceduresApi(library);
  vi.stubGlobal("fetch", vi.fn(api.fetch));

  render(
    <MemoryRouter initialEntries={[entry]}>
      <ProceduresPage />
    </MemoryRouter>
  );

  return api;
}

test("ProceduresPage shows clickable linked documents in the detail panel", async () => {
  renderProcedures({
    procedures: [buildProcedure(31, { title: "Throttle body cleaning", linkedDocumentIds: [11] })],
    documents: [
      { id: 11, title: "Throttle body reference", system: "Engine", documentType: "Reference" },
    ],
  });

  expect(await screen.findByRole("heading", { name: "Throttle body cleaning" })).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "Open document Throttle body reference" })
  ).toHaveAttribute("href", "/documents?documentId=11#document-library");
});

test("ProceduresPage supports search, filters, and filtered count in the list area", async () => {
  const api = renderProcedures({ procedures: [THROTTLE, REAR_BRAKES] });

  expect(await screen.findByPlaceholderText(SEARCH_PLACEHOLDER)).toBeInTheDocument();
  expect(
    await screen.findByText(getCountTextMatcher("Showing 1–2 of 2 procedures."))
  ).toBeInTheDocument();

  // The keyword goes to the server once typing pauses, and the list is what the
  // server answers with.
  fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), {
    target: { value: "brake" },
  });

  expect(
    await screen.findByText(getCountTextMatcher("Showing 1–1 of 1 procedure."))
  ).toBeInTheDocument();
  expect(api.listRequests.at(-1).get("q")).toBe("brake");
  expect(screen.getAllByText("Rear brake pad replacement").length).toBeGreaterThan(0);
  expect(screen.queryAllByText("Throttle body cleaning")).toHaveLength(0);

  fireEvent.change(screen.getByLabelText("Difficulty filter"), {
    target: { value: "beginner" },
  });

  // Zero matches gets a sentence, never an impossible "Showing 1-0 of 0". The
  // counter in the filter bar and the list's own empty state both say it, so
  // this asserts the pair rather than a single node.
  await waitFor(() =>
    expect(
      screen.getAllByText(getCountTextMatcher("No procedures match these filters."))
    ).toHaveLength(2)
  );
  // The empty state names a control that really exists in the filter bar.
  expect(
    await screen.findByText(
      "Change the filters or use Clear filters to see your saved procedures."
    )
  ).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(
    await screen.findByText(getCountTextMatcher("Showing 1–2 of 2 procedures."))
  ).toBeInTheDocument();
  expect((await screen.findAllByText("Throttle body cleaning")).length).toBeGreaterThan(0);
}, 10000);

test("ProceduresPage keeps showing the procedure the owner chose when a filter hides its row", async () => {
  const api = renderProcedures({ procedures: [THROTTLE, REAR_BRAKES] });

  // Newest first, so the rear brakes are the page's first row and the default.
  expect(
    await screen.findByRole("heading", { name: "Rear brake pad replacement" })
  ).toBeInTheDocument();

  fireEvent.click(screen.getByText("Throttle body cleaning"));
  expect(
    await screen.findByRole("heading", { name: "Throttle body cleaning" })
  ).toBeInTheDocument();

  fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), {
    target: { value: "brake" },
  });

  await waitFor(() => expect(api.listRequests.at(-1).get("q")).toBe("brake"));
  expect(
    await screen.findByText(getCountTextMatcher("Showing 1–1 of 1 procedure."))
  ).toBeInTheDocument();
  // The filter hides the throttle row from the list, not from the panel: the
  // owner chose it, so loosening the filter finds them where they were.
  expect(screen.getByRole("heading", { name: "Throttle body cleaning" })).toBeInTheDocument();
  expect(api.lookups).toContain("/api/procedures/31");
}, 10000);

test("ProceduresPage selects the requested procedure from the URL when the id exists", async () => {
  renderProcedures({ procedures: [THROTTLE, REAR_BRAKES] }, "/procedures?procedureId=31");

  expect(
    await screen.findByRole("heading", { name: "Throttle body cleaning" })
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Rear brake pad replacement" })
  ).not.toBeInTheDocument();
});
