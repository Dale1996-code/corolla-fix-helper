import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { RepairPlannerPage } from "./RepairPlannerPage";
import {
  AI_DISCLOSURE_PLANNER,
  AI_PLANNER_LIMITS,
  AI_SAFETY_WARNING,
} from "../components/feedback/AiSafetyNotices";

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
  {
    type: "done",
    status: "completed",
    evidenceStatus: "partial",
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
        safetyFlags: ["Brake work affects stopping safety."],
        rubric: [
          { id: "tools_listed", label: "Required tools listed", points: 25, met: true },
          {
            id: "safety_reviewed",
            label: "Safety-critical work acknowledged",
            points: 20,
            met: false,
          },
        ],
        gaps: ["Safety-critical work detected (brake system)."],
      },
      // The handle the acknowledgment control posts against. Without it the
      // rubric row above would be permanently unsatisfiable.
      planRunId: "run-abc",
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
      requirements: {
        tools: { status: "unknown", required: [], satisfied: [], missing: [] },
        parts: { status: "satisfied", required: ["brake pads"], satisfied: ["brake pads"], missing: [] },
      },
      evidence: {
        verifiedClaims: [
          { taskId: 1, kind: "numeric_spec", claim: "torque caliper bolts to 25 ft-lb", sourceId: "S1" },
        ],
        gaps: ["Required tools could not be established from your documents."],
      },
      handoffNotes: {
        partsShoppingList: "Parts run: brake pads",
        mechanicHandoff: "Vehicle: Corolla",
        maintenanceLogEntry: "Maintenance log",
      },
      // The server-built checklist the page may offer to save. It is a preview
      // only: the page posts `checklistDraftId` and never this content.
      checklistDraftId: "draft-abc",
      checklistDraft: {
        title: "Replace front brake pads",
        status: "planned",
        description: "Saved from a Repair Planner run (evidence: partial).",
        notes:
          "Verified statements from your documents\n1. Replace front brake pads\n   - torque caliper bolts to 25 ft-lb (Brake Service Guide, page 4)",
        items: [{ text: "Replace front brake pads" }],
        evidenceStatus: "partial",
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

// --- General AI disclosure and safety warning --------------------------------
//
// These are the page-level notices, not the per-plan ones. The planner shipped
// with neither: the only cautionary text on the page appeared after a run
// finished, and the strongest of it only when the server happened to flag the
// plan safety-critical. So an owner could describe a brake job, read a streamed
// plan, and never be told the output was AI-generated or that it needed checking
// against the manual.

// Every notice is expected in every state -- the point of the fix is that they
// do not depend on a run existing, succeeding, or being hazardous.
function expectGeneralNotices() {
  expect(screen.getByText(AI_SAFETY_WARNING)).toBeInTheDocument();
  expect(screen.getByText(AI_PLANNER_LIMITS)).toBeInTheDocument();
  expect(screen.getByText(AI_DISCLOSURE_PLANNER)).toBeInTheDocument();
}

test("the AI disclosure and safety warning are on screen before any plan is built", () => {
  vi.stubGlobal("fetch", vi.fn());

  renderPage();

  expectGeneralNotices();

  // Ahead of the control they warn about, not below the results. Comparing
  // document positions is what actually pins "before the user acts" -- asserting
  // presence alone would still pass if the banners were appended at the bottom.
  const warning = screen.getByText(AI_SAFETY_WARNING);
  const submit = screen.getByRole("button", { name: "Build repair plan" });
  expect(warning.compareDocumentPosition(submit)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING
  );
});

test("the general notices survive a completed plan, a failed run, and Clear", async () => {
  const fetchMock = vi.fn(() => streamResponse(completedRun));
  vi.stubGlobal("fetch", fetchMock);

  renderPage();
  fireEvent.change(screen.getByLabelText(/repair brief/i), {
    target: { value: "Front brakes squeak when stopping." },
  });
  fireEvent.click(screen.getByRole("button", { name: /build repair plan/i }));

  expect(await screen.findByRole("heading", { name: "Owner checklist" })).toBeInTheDocument();
  expectGeneralNotices();

  // Not swallowed by the agent activity log -- an owner scanning the run should
  // find the warning as page furniture, not as one more streamed line item.
  const activityLog = screen
    .getByRole("heading", { name: "Agent activity" })
    .closest("section");
  expect(within(activityLog).queryByText(AI_SAFETY_WARNING)).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  expectGeneralNotices();
});

test("the general notices are still shown when the run fails", async () => {
  const fetchMock = vi.fn(() =>
    streamResponse([
      { type: "status", message: "Analyzing repair brief..." },
      { type: "error", message: "The planner could not finish." },
    ])
  );
  vi.stubGlobal("fetch", fetchMock);

  renderPage();
  fireEvent.change(screen.getByLabelText(/repair brief/i), {
    target: { value: "Front brakes squeak when stopping." },
  });
  fireEvent.click(screen.getByRole("button", { name: /build repair plan/i }));

  expect(await screen.findByText("The planner could not finish.")).toBeInTheDocument();
  expectGeneralNotices();
});

// --- Safety acknowledgment ---------------------------------------------------
//
// The readiness rubric charges 20 points for "Safety-critical work
// acknowledged". These tests exist because the page once rendered that
// requirement with no control anywhere that could satisfy it, so a
// safety-critical plan could never reach Ready.

const ACK_LABEL = /I understand this plan includes safety-critical work/i;

// What the server returns once the run is re-scored with the risk acknowledged.
const acknowledgedResponse = {
  planRunId: "run-abc",
  safetyAcknowledged: true,
  readiness: {
    score: 100,
    level: "ready",
    safetyCritical: true,
    safetyAcknowledged: true,
    safetyFlags: ["Brake work affects stopping safety."],
    rubric: [
      { id: "tools_listed", label: "Required tools listed", points: 25, met: true },
      { id: "safety_reviewed", label: "Safety-critical work acknowledged", points: 20, met: true },
    ],
    gaps: [],
  },
  checklist: [
    {
      taskId: 1,
      task: "Replace front brake pads",
      system: "Brakes",
      owner: "DIY",
      safetyCritical: true,
      safetyFlags: ["Brake work affects stopping safety."],
      priority: 2,
      steps: ["Review source procedure"],
    },
  ],
};

function mockPlanThenAcknowledgment(ackResult = { ok: true, json: async () => acknowledgedResponse }) {
  const fetchMock = vi.fn((url) =>
    String(url).includes("safety-acknowledgment")
      ? Promise.resolve(ackResult)
      : streamResponse(completedRun)
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function buildSafetyCriticalPlan() {
  renderPage();
  fireEvent.change(screen.getByLabelText(/repair brief/i), {
    target: { value: "Front brakes squeak when stopping." },
  });
  fireEvent.click(screen.getByRole("button", { name: /build repair plan/i }));
  return screen.findByRole("checkbox", { name: ACK_LABEL });
}

test("a safety-critical plan renders an unchecked acknowledgment control it cannot reach Ready without", async () => {
  mockPlanThenAcknowledgment();

  const checkbox = await buildSafetyCriticalPlan();

  // Accessible name, correct initial state, keyboard reachable (a real checkbox
  // input is focusable and togglable with Space -- no div-with-onClick).
  expect(checkbox).not.toBeChecked();
  expect(checkbox).toBeEnabled();
  expect(checkbox).not.toHaveAttribute("tabindex", "-1");

  // The requirement it satisfies is unmet, and the plan is held below Ready.
  expect(screen.getByText("Safety-critical work acknowledged (20 pts)")).toBeInTheDocument();
  expect(screen.getByText("Almost ready")).toBeInTheDocument();
  expect(screen.queryByText("Ready")).not.toBeInTheDocument();

  // The control names the requirement it unlocks and the limit of what it means.
  const describedBy = checkbox.getAttribute("aria-describedby").split(" ");
  expect(describedBy).toContain("readiness-rubric-safety_reviewed");
  expect(
    document.getElementById("readiness-rubric-safety_reviewed")
  ).toHaveTextContent("Safety-critical work acknowledged");
  expect(document.getElementById(describedBy[1])).toHaveTextContent(
    /does not mean the repair is safe/i
  );

  // The hazard being acknowledged is stated, not just referred to.
  expect(
    screen.getByRole("region", { name: /safety-critical work: acknowledgment required/i })
  ).toHaveTextContent("Brake work affects stopping safety.");
});

// The failure mode the general banner could introduce: a page-wide "you were
// warned" notice reading as the per-plan acknowledgment, so a hazardous plan
// looks signed off before the owner has ticked anything.
test("the general safety banner does not acknowledge a safety-critical plan", async () => {
  mockPlanThenAcknowledgment();

  const checkbox = await buildSafetyCriticalPlan();

  // The general notices are present...
  expectGeneralNotices();

  // ...and the plan-specific requirement is untouched by them.
  expect(checkbox).not.toBeChecked();
  expect(
    screen.getByRole("region", { name: /safety-critical work: acknowledgment required/i })
  ).toBeInTheDocument();
  expect(screen.getByText("Almost ready")).toBeInTheDocument();
  expect(screen.queryByText("Ready")).not.toBeInTheDocument();

  // The hazard the server flagged is still stated in full, not replaced or
  // softened by the general wording.
  expect(screen.getAllByText(/Brake work affects stopping safety\./).length).toBeGreaterThan(0);

  // The two live in different regions: the general banner is page-level, the
  // acknowledgment belongs to the readiness card.
  const ackRegion = screen.getByRole("region", {
    name: /safety-critical work: acknowledgment required/i,
  });
  expect(within(ackRegion).queryByText(AI_SAFETY_WARNING)).not.toBeInTheDocument();
});

test("acknowledging updates readiness and the checklist without regenerating the plan", async () => {
  const fetchMock = mockPlanThenAcknowledgment();

  const checkbox = await buildSafetyCriticalPlan();
  fireEvent.click(checkbox);

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/repair-plan/run-abc/safety-acknowledgment",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ acknowledged: true }),
      })
    );
  });

  expect(await screen.findByText("100/100")).toBeInTheDocument();
  expect(screen.getByText("Ready")).toBeInTheDocument();
  expect(checkbox).toBeChecked();
  expect(screen.getByText("DIY")).toBeInTheDocument();
  expect(screen.queryByText(/Safety-critical work detected/)).not.toBeInTheDocument();

  // Acknowledging is not dismissing: the hazard warning stays on screen.
  expect(screen.getAllByText(/Brake work affects stopping safety/).length).toBeGreaterThan(0);

  // The plan itself was requested exactly once -- no regeneration.
  expect(fetchMock.mock.calls.filter(([url]) => url === "/api/repair-plan")).toHaveLength(1);

  // The panel must not keep demanding an acknowledgment the owner has given
  // while the rubric row above it reads as met.
  expect(screen.queryByText(/cannot reach Ready until you acknowledge/i)).not.toBeInTheDocument();
  expect(screen.getByText(/You have acknowledged the risk in this plan/i)).toBeInTheDocument();
});

test("the checked state follows the server's score, not the click", async () => {
  // The server refuses the acknowledgment (an expired run). The box must not
  // stay ticked while the rubric row says otherwise.
  mockPlanThenAcknowledgment({
    ok: false,
    json: async () => ({ error: "That plan is no longer available to acknowledge." }),
  });

  const checkbox = await buildSafetyCriticalPlan();
  fireEvent.click(checkbox);

  expect(
    await screen.findByText("That plan is no longer available to acknowledge.")
  ).toBeInTheDocument();
  expect(checkbox).not.toBeChecked();
  expect(screen.getByText("80/100")).toBeInTheDocument();
  expect(screen.queryByText("Ready")).not.toBeInTheDocument();
});

test("clearing the planner drops the acknowledgment along with the plan", async () => {
  mockPlanThenAcknowledgment();

  const checkbox = await buildSafetyCriticalPlan();
  fireEvent.click(checkbox);
  await waitFor(() => expect(checkbox).toBeChecked());

  fireEvent.click(screen.getByRole("button", { name: "Clear" }));

  expect(screen.queryByRole("checkbox", { name: ACK_LABEL })).not.toBeInTheDocument();
  expect(screen.queryByText("100/100")).not.toBeInTheDocument();
});

test("regenerating a plan starts the acknowledgment unchecked again", async () => {
  mockPlanThenAcknowledgment();

  const checkbox = await buildSafetyCriticalPlan();
  fireEvent.click(checkbox);
  await waitFor(() => expect(checkbox).toBeChecked());

  // Same page, a materially changed brief, a fresh run.
  fireEvent.change(screen.getByLabelText(/repair brief/i), {
    target: { value: "Replace the rear brake shoes and bleed the system." },
  });
  fireEvent.click(screen.getByRole("button", { name: /build repair plan/i }));

  const regenerated = await screen.findByRole("checkbox", { name: ACK_LABEL });
  expect(regenerated).not.toBeChecked();
  expect(screen.getByText("80/100")).toBeInTheDocument();
  expect(screen.queryByText("Ready")).not.toBeInTheDocument();
});

test("a plan with no safety-critical work shows no acknowledgment control or blocker", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      streamResponse([
        {
          type: "done",
          status: "completed",
          evidenceStatus: "verified",
          text: "Oil change plan",
          artifacts: {
            tasks: [{ id: 1, title: "Change the engine oil", system: "Engine", difficulty: "beginner" }],
            citations: [],
            readiness: {
              score: 100,
              level: "ready",
              safetyCritical: false,
              safetyAcknowledged: true,
              safetyFlags: [],
              rubric: [
                {
                  id: "safety_reviewed",
                  label: "Safety-critical work acknowledged",
                  points: 20,
                  met: true,
                },
              ],
              gaps: [],
            },
            checklist: [],
            handoffNotes: null,
            evidence: { verifiedClaims: [], gaps: [] },
          },
        },
      ])
    )
  );

  renderPage();
  fireEvent.change(screen.getByLabelText(/repair brief/i), {
    target: { value: "Change the engine oil." },
  });
  fireEvent.click(screen.getByRole("button", { name: /build repair plan/i }));

  expect(await screen.findByText("Ready")).toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: ACK_LABEL })).not.toBeInTheDocument();
  expect(screen.queryByText(/acknowledgment required/i)).not.toBeInTheDocument();
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

// --- Evidence status --------------------------------------------------------

function doneFrame(evidenceStatus, gaps = []) {
  return {
    type: "done",
    status: "completed",
    evidenceStatus,
    text: "Repair plan\n\n1. Torque caliper bolts to 25 ft-lb [S1]",
    artifacts: {
      tasks: [{ id: 1, title: "Replace front brake pads", system: "Brakes", difficulty: "beginner" }],
      citations: [],
      readiness: { score: 30, level: "not_ready", rubric: [], gaps: [] },
      checklist: [],
      handoffNotes: null,
      requirements: {
        tools: { status: "unknown", required: [], satisfied: [], missing: [] },
        parts: { status: "unknown", required: [], satisfied: [], missing: [] },
      },
      evidence: { verifiedClaims: [], gaps },
    },
  };
}

async function runWithFrames(frames) {
  vi.stubGlobal("fetch", vi.fn(() => streamResponse(frames)));
  renderPage();
  fireEvent.change(screen.getByLabelText(/repair brief/i), {
    target: { value: "Replace the front brake pads." },
  });
  fireEvent.click(screen.getByRole("button", { name: /build repair plan/i }));
}

test("RepairPlannerPage renders each evidence status with honest wording", async () => {
  await runWithFrames([doneFrame("verified")]);

  expect(await screen.findByText("Verified against your documents")).toBeInTheDocument();
  // "Verified" must not read as a promise about the manuals themselves.
  expect(screen.getByText(/not a promise that your manuals cover the whole repair/i)).toBeInTheDocument();
});

test("RepairPlannerPage shows the partial banner and its gaps", async () => {
  await runWithFrames([
    doneFrame("partial", ["Required tools could not be established from your documents."]),
  ]);

  expect(await screen.findByText("Partly verified")).toBeInTheDocument();
  expect(
    screen.getByText("Required tools could not be established from your documents.")
  ).toBeInTheDocument();
});

test("RepairPlannerPage shows not_found without presenting the plan as guidance", async () => {
  await runWithFrames([doneFrame("not_found")]);

  expect(await screen.findByText("Not found in your documents")).toBeInTheDocument();
  expect(screen.getByText(/not as repair guidance/i)).toBeInTheDocument();
});

test("RepairPlannerPage renders the plan from done.text, not from model prose", async () => {
  await runWithFrames([
    // A planner that still leaked prose would show this. It must not appear:
    // the page renders done.text only.
    { type: "text_delta", text: "Torque everything to 54 Nm." },
    doneFrame("partial"),
  ]);

  expect(await screen.findByText(/Torque caliper bolts to 25 ft-lb/)).toBeInTheDocument();
  expect(screen.queryByText(/54 Nm/)).not.toBeInTheDocument();
});

// --- Save as repair checklist ------------------------------------------------
//
// Saving writes durable SQLite rows, so the page must (a) show the owner exactly
// what will be written before they commit to it, and (b) send nothing but the
// server's draft id.

const SAVE_BUTTON = /save as repair checklist/i;

const savedChecklistResponse = {
  ok: true,
  status: 201,
  json: async () => ({
    message: "Checklist saved from your repair plan.",
    created: true,
    checklist: { id: 42, title: "Replace front brake pads", items: [] },
  }),
};

function mockPlanThenSave(saveResult = savedChecklistResponse) {
  const fetchMock = vi.fn((url) =>
    String(url).includes("from-planner")
      ? Promise.resolve(saveResult)
      : streamResponse(completedRun)
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function buildPlanWithSavePanel() {
  renderPage();
  fireEvent.change(screen.getByLabelText(/repair brief/i), {
    target: { value: "Front brakes squeak when stopping." },
  });
  fireEvent.click(screen.getByRole("button", { name: /build repair plan/i }));
  return screen.findByRole("button", { name: SAVE_BUTTON });
}

test("the save panel previews the exact title and items, and states what is not copied", async () => {
  mockPlanThenSave();

  await buildPlanWithSavePanel();

  const panel = screen
    .getByRole("heading", { name: "Save as repair checklist" })
    .closest("section");

  // The title and the item list, exactly as the server built them. The text
  // appears twice on purpose: once as the checklist's title, once as its item.
  expect(within(panel).getByText("Checklist title")).toBeInTheDocument();
  expect(within(panel).getAllByText("Replace front brake pads")).toHaveLength(2);
  expect(within(panel).getByText("Items (1)")).toBeInTheDocument();

  // What the notes will hold, shown verbatim rather than described.
  expect(within(panel).getByText("Notes will contain")).toBeInTheDocument();
  expect(
    within(panel).getByText(/torque caliper bolts to 25 ft-lb \(Brake Service Guide, page 4\)/)
  ).toBeInTheDocument();

  // And what is deliberately left behind.
  expect(within(panel).getByText("Not copied")).toBeInTheDocument();
  expect(within(panel).getByText(/gaps list/i)).toBeInTheDocument();
  expect(within(panel).getByText(/placeholder steps/i)).toBeInTheDocument();
  expect(within(panel).getByText(/handoff drafts/i)).toBeInTheDocument();
  expect(within(panel).getByText(/readiness score/i)).toBeInTheDocument();
});

test("saving sends the draft id and nothing else", async () => {
  const fetchMock = mockPlanThenSave();

  const saveButton = await buildPlanWithSavePanel();
  fireEvent.click(saveButton);

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/repair-checklists/from-planner",
      expect.objectContaining({ method: "POST" })
    );
  });

  const saveCall = fetchMock.mock.calls.find(([url]) =>
    String(url).includes("from-planner")
  );

  // No task text, no claims, no warnings, no evidence -- one field.
  expect(JSON.parse(saveCall[1].body)).toEqual({ checklistDraftId: "draft-abc" });
});

test("a successful save reports it and offers a link to the saved checklist", async () => {
  mockPlanThenSave();

  const saveButton = await buildPlanWithSavePanel();
  fireEvent.click(saveButton);

  expect(
    await screen.findByText("Checklist saved from your repair plan.")
  ).toBeInTheDocument();

  const link = screen.getByRole("link", { name: "Open saved checklist" });
  expect(link).toHaveAttribute("href", "/repair-checklists?checklistId=42#checklist-library");

  // The owner stays on the Planner: the plan is still on screen.
  expect(screen.getByRole("heading", { name: "Launch readiness" })).toBeInTheDocument();
});

test("the save button is disabled while saving and cannot fire twice", async () => {
  let releaseSave;
  const pendingSave = new Promise((resolve) => {
    releaseSave = () => resolve(savedChecklistResponse);
  });
  const fetchMock = mockPlanThenSave(pendingSave);

  const saveButton = await buildPlanWithSavePanel();
  fireEvent.click(saveButton);

  await waitFor(() => {
    expect(screen.getByRole("button", { name: /saving\.\.\./i })).toBeDisabled();
  });

  // A second click while in flight must not queue a second checklist.
  fireEvent.click(screen.getByRole("button", { name: /saving\.\.\./i }));

  releaseSave();

  await waitFor(() => {
    expect(screen.getByRole("button", { name: /^saved$/i })).toBeDisabled();
  });

  // A click after success is a no-op too.
  fireEvent.click(screen.getByRole("button", { name: /^saved$/i }));

  const saveCalls = fetchMock.mock.calls.filter(([url]) =>
    String(url).includes("from-planner")
  );
  expect(saveCalls).toHaveLength(1);
});

test("a failed save shows the server's guidance and leaves the button usable", async () => {
  mockPlanThenSave({
    ok: false,
    status: 404,
    json: async () => ({
      error: "That repair plan is no longer available to save. Build the plan again.",
    }),
  });

  const saveButton = await buildPlanWithSavePanel();
  fireEvent.click(saveButton);

  expect(
    await screen.findByText(
      "That repair plan is no longer available to save. Build the plan again."
    )
  ).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Open saved checklist" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: SAVE_BUTTON })).toBeEnabled();
});

test("no save panel is offered for a run that produced no draft", async () => {
  // doneFrame() artifacts carry no checklistDraftId -- an older server, or a run
  // that ended without one. The panel must not appear with nothing to save.
  await runWithFrames([doneFrame("partial")]);

  expect(await screen.findByText("Partly verified")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: SAVE_BUTTON })).not.toBeInTheDocument();
});

test("building another plan is blocked while a checklist save is in flight", async () => {
  let releaseSave;
  const pendingSave = new Promise((resolve) => {
    releaseSave = () => resolve(savedChecklistResponse);
  });
  mockPlanThenSave(pendingSave);

  const saveButton = await buildPlanWithSavePanel();
  fireEvent.click(saveButton);

  // Two plans and one in-flight save is the genuinely confusing case: there
  // would be no way to tell which plan a late banner belonged to.
  await waitFor(() => {
    expect(screen.getByRole("button", { name: /build repair plan/i })).toBeDisabled();
  });

  releaseSave();

  await waitFor(() => {
    expect(screen.getByRole("button", { name: /build repair plan/i })).toBeEnabled();
  });
});

test("clearing the plan mid-save still reaches the owner with the saved checklist", async () => {
  // Clear stays available during a save, so this path is real rather than
  // theoretical. The run-scoped result is deliberately discarded when the run
  // changes; the checklist row exists regardless, so the receipt must survive.
  let releaseSave;
  const pendingSave = new Promise((resolve) => {
    releaseSave = () => resolve(savedChecklistResponse);
  });
  mockPlanThenSave(pendingSave);

  const saveButton = await buildPlanWithSavePanel();
  fireEvent.click(saveButton);

  fireEvent.click(screen.getByRole("button", { name: "Clear" }));

  // The plan really is gone -- this is the state that used to swallow the save.
  expect(screen.queryByRole("button", { name: SAVE_BUTTON })).not.toBeInTheDocument();

  releaseSave();

  // The owner is still told the checklist exists, and can still open it.
  expect(await screen.findByText("Checklist saved")).toBeInTheDocument();
  expect(
    screen.getByText(/no longer on this page\. The plan is gone, but the checklist is not\./)
  ).toBeInTheDocument();

  const link = screen.getByRole("link", { name: "Open saved checklist" });
  expect(link).toHaveAttribute("href", "/repair-checklists?checklistId=42#checklist-library");
});

test("the ordinary save path confirms once, not twice", async () => {
  mockPlanThenSave();

  const saveButton = await buildPlanWithSavePanel();
  fireEvent.click(saveButton);

  await screen.findByText("Checklist saved from your repair plan.");

  // The standing receipt is for a plan that is GONE. While the panel is still
  // reporting this same checklist, showing both would be noise.
  expect(screen.queryByText("Checklist saved")).not.toBeInTheDocument();
  expect(screen.getAllByRole("link", { name: "Open saved checklist" })).toHaveLength(1);
});
