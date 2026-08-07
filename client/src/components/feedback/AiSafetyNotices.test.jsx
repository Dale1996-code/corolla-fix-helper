import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { SearchPage } from "../../pages/SearchPage";
import { RepairPlannerPage } from "../../pages/RepairPlannerPage";
import {
  AI_DISCLOSURE_ASK,
  AI_DISCLOSURE_PLANNER,
  AI_PLANNER_LIMITS,
  AI_SAFETY_WARNING,
  AiSafetyNotices,
} from "./AiSafetyNotices";

// The reason this file exists: the AI disclosure and the safety warning were
// literals inside SearchPage, and the Repair Planner had neither. Copying the
// strings across would have made the next edit to one of them a silent
// divergence, where the two AI features tell the owner different things about
// the same risk. These tests fail if either page stops sourcing its warning from
// the shared module.

// SearchPage fires four search requests plus an attachment load on mount. None
// of it matters here, so every call gets the same empty payload.
function stubEmptyApi() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({ results: [], total: 0, filters: {}, attachments: [] }),
      })
    )
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("both AI features render the same general safety warning", async () => {
  stubEmptyApi();

  const { unmount } = render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );
  expect(await screen.findByText(AI_SAFETY_WARNING)).toBeInTheDocument();
  unmount();

  render(
    <MemoryRouter initialEntries={["/repair-planner"]}>
      <RepairPlannerPage />
    </MemoryRouter>
  );
  expect(screen.getByText(AI_SAFETY_WARNING)).toBeInTheDocument();
});

test("each AI feature discloses the model call in terms of what it actually sends", async () => {
  stubEmptyApi();

  const { unmount } = render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );
  // Ask sends a question and can include a photo; the planner sends a brief and
  // cannot. Same disclosure, different inputs named -- so neither page can be
  // caught describing data it does not send.
  expect(await screen.findByText(AI_DISCLOSURE_ASK)).toBeInTheDocument();
  expect(screen.queryByText(AI_DISCLOSURE_PLANNER)).not.toBeInTheDocument();
  unmount();

  render(
    <MemoryRouter initialEntries={["/repair-planner"]}>
      <RepairPlannerPage />
    </MemoryRouter>
  );
  expect(screen.getByText(AI_DISCLOSURE_PLANNER)).toBeInTheDocument();
  expect(screen.queryByText(AI_DISCLOSURE_ASK)).not.toBeInTheDocument();
});

test("every notice states its point in words, not by colour or icon alone", () => {
  render(
    <AiSafetyNotices disclosure={AI_DISCLOSURE_PLANNER} extraWarning={AI_PLANNER_LIMITS} />
  );

  // The four things the planner banner has to say out loud.
  const warning = screen.getByText(AI_PLANNER_LIMITS);
  expect(warning).toHaveTextContent(/AI-assisted/i);
  expect(warning).toHaveTextContent(/incomplete, wrong, or unsupported/i);
  expect(warning).toHaveTextContent(/serious injury/i);
  expect(warning).toHaveTextContent(/get qualified help/i);
});

test("the extra warning is not a paragraph nested inside a paragraph", () => {
  const { container } = render(
    <AiSafetyNotices disclosure={AI_DISCLOSURE_PLANNER} extraWarning={AI_PLANNER_LIMITS} />
  );

  // jsdom parses through React rather than the HTML parser, so an invalid <p>
  // inside <p> would render here and only break in a real browser (which
  // reparents it, splitting the banner). Assert the structure directly.
  expect(container.querySelector("p p")).toBeNull();

  const warning = screen.getByText(AI_PLANNER_LIMITS);
  expect(warning.tagName).toBe("SPAN");
  expect(warning.closest("p")).toHaveTextContent(AI_SAFETY_WARNING);
});

test("the shared sentence stays its own node so the two pages can be compared on it", () => {
  render(<AiSafetyNotices disclosure={AI_DISCLOSURE_ASK} />);

  // With no extra warning the amber paragraph is exactly the shared sentence --
  // this is the exact-text match Ask AI's own test relies on.
  const warning = screen.getByText(AI_SAFETY_WARNING);
  expect(warning.tagName).toBe("P");
  expect(warning.textContent).toBe(AI_SAFETY_WARNING);
});
