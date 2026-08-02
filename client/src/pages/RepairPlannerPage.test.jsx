import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { RepairPlannerPage } from "./RepairPlannerPage";

function streamResponse(events) {
  const encoder = new TextEncoder();
  const frames = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
  let index = 0;

  const reader = {
    read: async () => {
      if (index < frames.length) {
        const value = encoder.encode(frames[index]);
        index += 1;
        return { value, done: false };
      }
      return { value: undefined, done: true };
    },
    releaseLock: () => {},
  };

  return Promise.resolve({ ok: true, body: { getReader: () => reader } });
}

const completedRun = [
  { type: "status", message: "Analyzing repair brief..." },
  { type: "tool_call", name: "extract_repair_tasks" },
  { type: "tool_result", name: "extract_repair_tasks", summary: "Found 1 task(s)." },
  { type: "tool_call", name: "search_repair_docs" },
  { type: "text_delta", text: "The brake job is the priority. " },
  { type: "text_delta", text: "Follow-up questions: What is the mileage?" },
  {
    type: "done",
    status: "completed",
    text: "The brake job is the priority.",
    artifacts: {
      tasks: [
        {
          id: 1,
          title: "Replace front brake pads",
          system: "Brakes",
          difficulty: "intermediate",
          safetyFlags: ["Brake work affects stopping safety."],
        },
      ],
      citations: [
        {
          documentId: 7,
          documentTitle: "Brake Service Guide",
          originalFilename: "brake-guide.pdf",
          pageNumber: 4,
          chunkIndex: 1,
          snippet: "torque caliper bolts to 25 ft-lb",
        },
      ],
      // Brake work the owner has not acknowledged: tools, parts, and skill all
      // score, but the safety row cannot, so the run is capped below Ready and
      // the job is routed to a shop. This is what the server actually produces
      // now -- the old fixture claimed Ready + DIY, which is unreachable.
      readiness: {
        score: 80,
        level: "almost_ready",
        safetyCritical: true,
        safetyAcknowledged: false,
        rubric: [{ id: "tools_listed", label: "Required tools listed", points: 25, met: true }],
        gaps: ["Safety-critical work detected (brake system)."],
      },
      checklist: [
        {
          taskId: 1,
          task: "Replace front brake pads",
          system: "Brakes",
          owner: "Shop Recommended",
          safetyCritical: true,
          safetyReason: "Safety-critical work detected (brake system).",
          priority: 2,
          steps: ["Review source procedure", "Gather parts", "Perform the repair"],
        },
      ],
      handoffNotes: {
        partsShoppingList: "Parts run: brake pads",
        mechanicHandoff: "Vehicle: Corolla",
        maintenanceLogEntry: "Maintenance log",
      },
    },
  },
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/repair-planner"]}>
      <RepairPlannerPage />
    </MemoryRouter>
  );
}

test("RepairPlannerPage validates an empty brief before calling the API", () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  renderPage();

  fireEvent.click(screen.getByRole("button", { name: "Build repair plan" }));

  expect(screen.getByText("Enter a repair brief before planning.")).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});

test("RepairPlannerPage streams agent activity, plan text, and structured artifacts", async () => {
  const fetchMock = vi.fn(() => streamResponse(completedRun));
  vi.stubGlobal("fetch", fetchMock);

  renderPage();

  fireEvent.change(screen.getByRole("textbox", { name: "Repair brief" }), {
    target: { value: "Front brakes squeak when stopping." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Build repair plan" }));

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/repair-plan",
      expect.objectContaining({ method: "POST" })
    );
  });

  // Streamed narrative text (model deltas).
  expect(await screen.findByText(/The brake job is the priority/)).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Prioritized plan" })).toBeInTheDocument();

  // Tool progress events.
  expect(screen.getByText("Calling extract_repair_tasks")).toBeInTheDocument();
  expect(screen.getByText("Found 1 task(s).")).toBeInTheDocument();

  // Structured artifacts from the done event.
  expect(screen.getByText("80/100")).toBeInTheDocument();
  expect(screen.getByText("Almost ready")).toBeInTheDocument();
  expect(screen.queryByText("Ready")).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Owner checklist" })).toBeInTheDocument();

  const sourceLink = screen.getByRole("link", {
    name: "Open source Brake Service Guide Page 4",
  });
  expect(sourceLink).toHaveAttribute("href", "/documents?documentId=7#document-library");
  expect(within(sourceLink).getByText("torque caliper bolts to 25 ft-lb")).toBeInTheDocument();
});

test("RepairPlannerPage shows a preparation-guidance safety disclaimer with readiness", async () => {
  const fetchMock = vi.fn(() => streamResponse(completedRun));
  vi.stubGlobal("fetch", fetchMock);

  renderPage();

  fireEvent.change(screen.getByRole("textbox", { name: "Repair brief" }), {
    target: { value: "Front brakes squeak when stopping." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Build repair plan" }));

  expect(
    await screen.findByText(
      "Steps are preparation guidance, not verified repair instructions."
    )
  ).toBeInTheDocument();
});

test("RepairPlannerPage shows the AI-not-configured message from the stream", async () => {
  const fetchMock = vi.fn(() =>
    streamResponse([
      {
        type: "ai_not_configured",
        message: "AI is not configured yet. Set OPENAI_API_KEY in the server environment to enable the Repair Planner.",
      },
      { type: "done", status: "ai_not_configured", artifacts: {} },
    ])
  );
  vi.stubGlobal("fetch", fetchMock);

  renderPage();

  fireEvent.change(screen.getByRole("textbox", { name: "Repair brief" }), {
    target: { value: "Replace the front brake pads." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Build repair plan" }));

  expect(await screen.findByText("AI not configured")).toBeInTheDocument();
  expect(
    screen.getByText(
      "AI is not configured yet. Set OPENAI_API_KEY in the server environment to enable the Repair Planner."
    )
  ).toBeInTheDocument();
});

// --- Incomplete-stream handling --------------------------------------------
//
// A stream that stops without a terminal frame used to be treated as success,
// so the page rendered whatever partial artifacts had accumulated as a
// finished plan. An owner cannot tell a truncated plan from a complete one.

test("RepairPlannerPage treats a stream that ends without a terminal frame as a failure", async () => {
  const fetchMock = vi.fn(() =>
    streamResponse([
      { type: "status", message: "Analyzing repair brief..." },
      { type: "tool_call", name: "search_repair_docs" },
      { type: "text_delta", text: "Partial plan that never finished" },
      // No done, no error: the connection just stops.
    ])
  );
  vi.stubGlobal("fetch", fetchMock);

  renderPage();
  fireEvent.change(screen.getByLabelText(/repair brief/i), {
    target: { value: "Replace the front brake pads." },
  });
  fireEvent.click(screen.getByRole("button", { name: /build repair plan/i }));

  expect(await screen.findByText(/connection ended before the plan was finished/i)).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Owner checklist" })).not.toBeInTheDocument();
});

test("RepairPlannerPage does not render results for a done frame that is not completed", async () => {
  const fetchMock = vi.fn(() =>
    streamResponse([
      { type: "text_delta", text: "Half a plan" },
      // A done frame reporting something other than success must not paint the
      // readiness and checklist cards.
      { type: "done", status: "truncated", artifacts: { readiness: { score: 80, level: "ready" } } },
    ])
  );
  vi.stubGlobal("fetch", fetchMock);

  renderPage();
  fireEvent.change(screen.getByLabelText(/repair brief/i), {
    target: { value: "Replace the front brake pads." },
  });
  fireEvent.click(screen.getByRole("button", { name: /build repair plan/i }));

  expect(await screen.findByText(/connection ended before the plan was finished/i)).toBeInTheDocument();
  expect(screen.queryByText("Ready")).not.toBeInTheDocument();
  expect(screen.queryByText("80/100")).not.toBeInTheDocument();
});

test("RepairPlannerPage surfaces a typed planner failure instead of a plan", async () => {
  const fetchMock = vi.fn(() =>
    streamResponse([
      { type: "tool_call", name: "search_repair_docs" },
      {
        type: "error",
        code: "planner_incomplete",
        reason: "turn_limit",
        message: "The planner ran out of steps before finishing a plan.",
      },
    ])
  );
  vi.stubGlobal("fetch", fetchMock);

  renderPage();
  fireEvent.change(screen.getByLabelText(/repair brief/i), {
    target: { value: "Replace the front brake pads." },
  });
  fireEvent.click(screen.getByRole("button", { name: /build repair plan/i }));

  expect(await screen.findByText(/ran out of steps/i)).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Owner checklist" })).not.toBeInTheDocument();
});
