import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { SectionCard } from "../components/SectionCard";
import { ErrorBanner, InfoBanner } from "../components/feedback/Banner";
import {
  AI_DISCLOSURE_PLANNER,
  AI_PLANNER_LIMITS,
  AiSafetyNotices,
} from "../components/feedback/AiSafetyNotices";
import { buildEntityLink } from "../lib/navigation";

const defaultForm = {
  brief: "",
  skillLevel: "beginner",
  availableTools: "",
  availableParts: "",
  constraints: "",
};

const initialRun = {
  status: "idle",
  statusMessage: "",
  activity: [],
  narrative: "",
  artifacts: null,
  evidenceStatus: "",
  message: "",
  // Whether the server sent a frame that actually ends a run (`done`, `error`,
  // or `ai_not_configured`). A stream that just stops -- a dropped connection,
  // a killed server, a proxy timeout -- used to be treated as success, so the
  // page showed a half-built plan as finished.
  sawTerminalEvent: false,
  // Per-run safety acknowledgment. It lives inside the run rather than beside
  // it, so every path that replaces the run -- a new plan, Clear, a failed
  // stream -- drops the acknowledgment along with the plan it belonged to.
  // There is no path that carries it onto a different plan.
  safetyAck: { acknowledged: false, pending: false, error: "" },
};

const INCOMPLETE_STREAM_MESSAGE =
  "The connection ended before the plan was finished. Nothing below is a complete plan — run it again.";

const READINESS_LABELS = {
  ready: { label: "Ready", className: "bg-emerald-100 text-emerald-800" },
  almost_ready: { label: "Almost ready", className: "bg-amber-100 text-amber-800" },
  not_ready: { label: "Not ready", className: "bg-red-100 text-red-800" },
};

function ActivityLog({ activity, statusMessage, isRunning }) {
  if (!activity.length && !statusMessage) {
    return null;
  }

  return (
    <SectionCard title="Agent activity">
      {isRunning ? (
        <p className="text-sm font-medium text-sky-700" role="status">
          {statusMessage || "Working..."}
        </p>
      ) : null}
      <ol className="space-y-2">
        {activity.map((item, index) => (
          <li
            key={`${item.kind}-${index}`}
            className="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700"
          >
            <span
              className={[
                "mt-0.5 rounded-full px-2 py-0.5 text-xs font-semibold",
                item.kind === "tool_call"
                  ? "bg-sky-100 text-sky-800"
                  : item.kind === "tool_result"
                    ? "bg-emerald-100 text-emerald-800"
                    : "bg-slate-200 text-slate-700",
              ].join(" ")}
            >
              {item.kind === "tool_call"
                ? "Tool"
                : item.kind === "tool_result"
                  ? "Result"
                  : "Step"}
            </span>
            <span>{item.text}</span>
          </li>
        ))}
      </ol>
    </SectionCard>
  );
}

function NarrativePanel({ narrative }) {
  if (!narrative) {
    return null;
  }

  return (
    <SectionCard title="Prioritized plan">
      <p className="whitespace-pre-wrap text-sm leading-6 text-slate-700">{narrative}</p>
    </SectionCard>
  );
}

// What each status means, in the owner's terms.
//
// "Verified" describes THIS RUN, not the manuals: every statement shown passed
// an exact quote-and-number check against the uploaded PDFs. It does not mean
// the PDFs cover the whole repair, and the wording has to say so -- otherwise
// the badge reads as an assurance the app cannot give.
const EVIDENCE_STATUS = {
  verified: {
    label: "Verified against your documents",
    className: "bg-emerald-100 text-emerald-800",
    detail:
      "Every statement below was matched word-for-word to a cited page of your uploaded manuals. That is a check on this plan, not a promise that your manuals cover the whole repair.",
  },
  partial: {
    label: "Partly verified",
    className: "bg-amber-100 text-amber-800",
    detail:
      "Some of this plan is grounded in your documents and some is not. Read the gaps before ordering parts or starting work.",
  },
  not_found: {
    label: "Not found in your documents",
    className: "bg-red-100 text-red-800",
    detail:
      "Nothing in this plan could be verified against your uploaded manuals. Treat it as a starting point for research, not as repair guidance.",
  },
};

function EvidencePanel({ evidenceStatus, evidence }) {
  const status = EVIDENCE_STATUS[evidenceStatus];

  if (!status) {
    return null;
  }

  const gaps = evidence?.gaps || [];

  return (
    <SectionCard title="Evidence">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${status.className}`}>
          {status.label}
        </span>
        {evidence?.verifiedClaims?.length ? (
          <span className="text-xs text-slate-500">
            {evidence.verifiedClaims.length} verified statement
            {evidence.verifiedClaims.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-sm leading-6 text-slate-600">{status.detail}</p>
      {gaps.length ? (
        <div className="mt-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Gaps</h4>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">
            {gaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </SectionCard>
  );
}

// The consequence the owner is accepting, stated plainly. Deliberately not "I
// agree": what is being confirmed is that the warning was read and that the
// cited paperwork still has to be checked by hand.
const SAFETY_ACK_LABEL =
  "I understand this plan includes safety-critical work, and that before starting I must read the cited procedures, warnings, lifting points, and torque specifications for myself.";

// The limit of what the checkbox means. It has to be next to the control,
// because the readiness score jumping to Ready right after it is ticked is
// exactly the moment "acknowledged" could be misread as "approved".
const SAFETY_ACK_DISCLAIMER =
  "Ticking this box does not mean the repair is safe, that the plan is correct, or that it suits your skill level. It only records that you have seen and understood this warning.";

const SAFETY_ACK_RUBRIC_ID = "readiness-rubric-safety_reviewed";
const SAFETY_ACK_DISCLAIMER_ID = "safety-acknowledgment-disclaimer";

/**
 * The control that satisfies the "Safety-critical work acknowledged" row of the
 * rubric.
 *
 * Rendered only when the SERVER classified this plan as safety-critical, and it
 * starts unticked on every plan: nothing here preselects it, and the checked
 * state shown is the one the server scored, not a local guess. Toggling posts to
 * the server, which re-scores the run from its own copy of the tasks and
 * requirements -- this component never computes a score.
 */
function SafetyAcknowledgment({ readiness, safetyAck, onToggle, canAcknowledge }) {
  const hazards = readiness.safetyFlags || [];
  // The heading and lead track the acknowledgment state, so the panel never
  // still demands an acknowledgment the owner has already given while the
  // rubric row above it reads as met.
  const acknowledged = safetyAck.acknowledged;

  return (
    <section
      aria-labelledby="safety-acknowledgment-heading"
      className="rounded-xl border border-amber-300 bg-amber-50 p-4"
    >
      <h3 id="safety-acknowledgment-heading" className="text-sm font-semibold text-amber-900">
        {acknowledged
          ? "Safety-critical work: risk acknowledged"
          : "Safety-critical work: acknowledgment required"}
      </h3>
      <p className="mt-1 text-sm leading-6 text-amber-900">
        {acknowledged
          ? "You have acknowledged the risk in this plan. Untick the box to withdraw it. This is what was flagged:"
          : "This plan cannot reach Ready until you acknowledge the risk below. Here is what was flagged:"}
      </p>
      {hazards.length ? (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900">
          {hazards.map((flag) => (
            <li key={flag}>{flag}</li>
          ))}
        </ul>
      ) : null}

      <label className="mt-3 flex items-start gap-3 text-sm text-amber-900">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0 rounded border-amber-400 accent-amber-700"
          checked={safetyAck.acknowledged}
          disabled={safetyAck.pending || !canAcknowledge}
          onChange={(event) => onToggle(event.target.checked)}
          // Ties the control to the rubric row it unlocks, and to the statement
          // of what it does not mean.
          aria-describedby={`${SAFETY_ACK_RUBRIC_ID} ${SAFETY_ACK_DISCLAIMER_ID}`}
        />
        <span>{SAFETY_ACK_LABEL}</span>
      </label>

      <p id={SAFETY_ACK_DISCLAIMER_ID} className="mt-2 text-xs leading-5 text-amber-800">
        {SAFETY_ACK_DISCLAIMER}
      </p>

      <p className="mt-2 text-xs text-amber-800" role="status">
        {safetyAck.pending ? "Updating readiness..." : ""}
      </p>
      {safetyAck.error ? (
        <p className="mt-1 text-xs font-semibold text-red-700" role="alert">
          {safetyAck.error}
        </p>
      ) : null}
      {!canAcknowledge && !safetyAck.error ? (
        <p className="mt-1 text-xs text-amber-800">
          This plan cannot be acknowledged. Build the plan again to enable the checkbox.
        </p>
      ) : null}
    </section>
  );
}

function ReadinessPanel({ readiness, safetyAck, onAcknowledgeSafety, canAcknowledge }) {
  if (!readiness) {
    return null;
  }

  const badge = READINESS_LABELS[readiness.level] || READINESS_LABELS.not_ready;

  return (
    <SectionCard title="Launch readiness">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-2xl font-bold text-slate-900">{readiness.score}/100</span>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${badge.className}`}>
          {badge.label}
        </span>
      </div>

      <InfoBanner className="text-xs">
        Steps are preparation guidance, not verified repair instructions.
      </InfoBanner>

      <ul className="space-y-2">
        {readiness.rubric.map((item) => (
          <li
            key={item.id}
            id={item.id === "safety_reviewed" ? SAFETY_ACK_RUBRIC_ID : undefined}
            className="flex items-center gap-2 text-sm text-slate-700"
          >
            <span aria-hidden="true">{item.met ? "✓" : "✗"}</span>
            <span className="sr-only">{item.met ? "Met: " : "Not met: "}</span>
            <span>
              {item.label} ({item.points} pts)
            </span>
          </li>
        ))}
      </ul>

      {readiness.safetyCritical ? (
        <SafetyAcknowledgment
          readiness={readiness}
          safetyAck={safetyAck}
          onToggle={onAcknowledgeSafety}
          canAcknowledge={canAcknowledge}
        />
      ) : null}

      {readiness.gaps.length ? (
        <InfoBanner tone="amber">
          <p className="font-semibold">Gaps to close</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {readiness.gaps.map((gap, index) => (
              <li key={index}>{gap}</li>
            ))}
          </ul>
        </InfoBanner>
      ) : null}
    </SectionCard>
  );
}

function ChecklistPanel({ checklist }) {
  if (!checklist?.length) {
    return null;
  }

  return (
    <SectionCard title="Owner checklist">
      <div className="space-y-3">
        {checklist.map((item) => (
          <article
            key={item.taskId}
            className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900">{item.task}</h3>
              <span
                className={[
                  "rounded-full px-3 py-1 text-xs font-semibold",
                  item.owner === "DIY"
                    ? "bg-sky-100 text-sky-800"
                    : "bg-purple-100 text-purple-800",
                ].join(" ")}
              >
                {item.owner}
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-500">{item.system}</p>
            {/* A row can only read "Shop Recommended" alongside the hazard that
                justifies it, so the reason travels with the recommendation. */}
            {item.safetyFlags?.length ? (
              <p className="mt-2 text-xs text-red-700">⚠ {item.safetyFlags.join(" ")}</p>
            ) : null}
            <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-slate-700">
              {item.steps.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
          </article>
        ))}
      </div>
    </SectionCard>
  );
}

function TasksPanel({ tasks }) {
  if (!tasks?.length) {
    return null;
  }

  return (
    <SectionCard title="Extracted tasks">
      <ul className="space-y-2">
        {tasks.map((task) => (
          <li
            key={task.id}
            className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-slate-900">{task.title}</span>
              <span className="rounded-full bg-slate-200 px-3 py-1 text-xs font-semibold text-slate-700">
                {task.system} · {task.difficulty}
              </span>
            </div>
            {task.safetyFlags?.length ? (
              <p className="mt-2 text-xs text-red-700">⚠ {task.safetyFlags.join(" ")}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function HandoffPanel({ handoffNotes }) {
  if (!handoffNotes) {
    return null;
  }

  const blocks = [
    { label: "Parts shopping list", value: handoffNotes.partsShoppingList },
    { label: "Mechanic handoff", value: handoffNotes.mechanicHandoff },
    { label: "Maintenance log entry", value: handoffNotes.maintenanceLogEntry },
  ];

  return (
    <SectionCard title="Handoff drafts">
      <div className="grid gap-3 md:grid-cols-3">
        {blocks.map((block) => (
          <div key={block.label} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              {block.label}
            </p>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">
              {block.value}
            </p>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

function SourcesPanel({ citations }) {
  if (!citations?.length) {
    return null;
  }

  return (
    <SectionCard title="Sources">
      <div className="grid gap-3 md:grid-cols-2">
        {citations.map((citation) => {
          const documentName =
            citation.documentTitle || citation.originalFilename || "Untitled document";
          const pageLabel = citation.pageNumber ? `Page ${citation.pageNumber}` : "Page unknown";

          return (
            <Link
              key={`${citation.documentId}-${citation.pageNumber}-${citation.chunkIndex}`}
              to={buildEntityLink("document", citation.documentId)}
              aria-label={`Open source ${documentName} ${pageLabel}`}
              className="block rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm transition hover:border-sky-300 hover:bg-sky-50"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <p className="font-semibold text-slate-900">{documentName}</p>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                  {pageLabel}
                </span>
              </div>
              <p className="mt-3 leading-6 text-slate-700">{citation.snippet}</p>
            </Link>
          );
        })}
      </div>
    </SectionCard>
  );
}

function StatusBanner({ status, message }) {
  if (status === "ai_not_configured") {
    return (
      <InfoBanner tone="amber" title="AI not configured" announce>
        {message}
      </InfoBanner>
    );
  }

  if (status === "error") {
    return <ErrorBanner title="Could not build the plan">{message}</ErrorBanner>;
  }

  return null;
}

function parseSseFrame(frame) {
  const line = frame
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.startsWith("data:"));

  if (!line) {
    return null;
  }

  try {
    return JSON.parse(line.slice(5).trim());
  } catch {
    return null;
  }
}

export function RepairPlannerPage() {
  const [form, setForm] = useState(defaultForm);
  const [run, setRun] = useState(initialRun);
  const runRef = useRef(initialRun);
  const abortRef = useRef(null);

  // Abort any in-flight repair-plan stream when the page unmounts so navigating
  // away does not leak the fetch (and its upstream OpenAI request).
  useEffect(() => () => abortRef.current?.abort(), []);

  const isRunning = run.status === "running";

  function updateRun(updater) {
    runRef.current = updater(runRef.current);
    setRun(runRef.current);
  }

  function handleEvent(event) {
    if (!event || typeof event.type !== "string") {
      return;
    }

    if (event.type === "status") {
      updateRun((current) => ({
        ...current,
        statusMessage: event.message || "",
        activity: [...current.activity, { kind: "status", text: event.message || "" }],
      }));
    } else if (event.type === "tool_call") {
      updateRun((current) => ({
        ...current,
        activity: [...current.activity, { kind: "tool_call", text: `Calling ${event.name}` }],
      }));
    } else if (event.type === "tool_result") {
      updateRun((current) => ({
        ...current,
        activity: [...current.activity, { kind: "tool_result", text: event.summary || event.name }],
      }));
    } else if (event.type === "ai_not_configured") {
      updateRun((current) => ({
        ...current,
        status: "ai_not_configured",
        message: event.message || "",
        sawTerminalEvent: true,
      }));
    } else if (event.type === "error") {
      updateRun((current) => ({
        ...current,
        status: "error",
        message: event.message || "",
        sawTerminalEvent: true,
      }));
    } else if (event.type === "done") {
      // Only a run the server marked completed may render results. A `done`
      // frame with any other status (or none) reports a run that ended without
      // a usable plan, so it must not paint readiness and checklist cards.
      const completed = event.status === "completed";

      updateRun((current) => {
        const settled = current.status === "error" || current.status === "ai_not_configured";

        if (settled) {
          return { ...current, statusMessage: "", sawTerminalEvent: true };
        }

        if (!completed) {
          return {
            ...current,
            status: "error",
            message: INCOMPLETE_STREAM_MESSAGE,
            artifacts: null,
            statusMessage: "",
            sawTerminalEvent: true,
          };
        }

        return {
          ...current,
          status: "done",
          // The plan text is rendered by the server from validated claims and
          // ships whole in the done frame. Nothing is assembled from model
          // deltas any more -- the planner no longer emits them.
          narrative: event.text || "",
          evidenceStatus: event.evidenceStatus || "",
          artifacts: event.artifacts || current.artifacts,
          statusMessage: "",
          sawTerminalEvent: true,
        };
      });
    }
  }

  async function handleSubmit(submitEvent) {
    submitEvent.preventDefault();

    const trimmedBrief = form.brief.trim();
    if (!trimmedBrief) {
      updateRun(() => ({
        ...initialRun,
        status: "error",
        message: "Enter a repair brief before planning.",
      }));
      return;
    }

    updateRun(() => ({ ...initialRun, status: "running", statusMessage: "Starting..." }));

    // Replace any prior in-flight stream with a fresh controller for this run.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/repair-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, brief: trimmedBrief }),
        signal: controller.signal,
      });

      if (!response.ok) {
        let message = "Could not start the repair planner.";
        try {
          const payload = await response.json();
          message = payload.error || message;
        } catch {
          // keep default message
        }
        updateRun((current) => ({ ...current, status: "error", message }));
        return;
      }

      if (!response.body || typeof response.body.getReader !== "function") {
        updateRun((current) => ({
          ...current,
          status: "error",
          message: "Streaming is not supported in this browser.",
        }));
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        let separatorIndex = buffer.indexOf("\n\n");
        while (separatorIndex !== -1) {
          const frame = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          handleEvent(parseSseFrame(frame));
          separatorIndex = buffer.indexOf("\n\n");
        }
      }

      // Flush any trailing frame without a terminating blank line.
      if (buffer.trim()) {
        handleEvent(parseSseFrame(buffer));
      }

      // The stream ended. If no terminal frame ever arrived the run did not
      // finish -- it was cut off. Reporting that as "done" rendered whatever
      // partial artifacts had accumulated as a finished plan.
      updateRun((current) => {
        if (current.status !== "running") {
          return current;
        }

        if (!current.sawTerminalEvent) {
          return {
            ...current,
            status: "error",
            message: INCOMPLETE_STREAM_MESSAGE,
            artifacts: null,
            statusMessage: "",
          };
        }

        return { ...current, status: "done", statusMessage: "" };
      });
    } catch (error) {
      // An aborted stream (unmount, or a newer run superseding this one) is not a
      // user-facing failure — leave the run state alone.
      if (error.name === "AbortError") {
        return;
      }

      updateRun((current) => ({
        ...current,
        status: "error",
        message: error.message || "Could not build the plan.",
      }));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }

  // Records (or withdraws) the acknowledgment for the CURRENT plan and adopts the
  // readiness and checklist the server sends back.
  //
  // Nothing about the score is computed here. The request carries a run id and a
  // boolean; the server re-runs the safety classifier over its own copy of the
  // canonical tasks and returns the result. That is why the page cannot talk a
  // safety-critical plan into looking non-critical.
  async function handleAcknowledgeSafety(nextAcknowledged) {
    const planRunId = runRef.current.artifacts?.planRunId;

    if (!planRunId || runRef.current.safetyAck.pending) {
      return;
    }

    updateRun((current) => ({
      ...current,
      safetyAck: { ...current.safetyAck, pending: true, error: "" },
    }));

    // A newer plan replacing this one mid-request must not receive this
    // acknowledgment, so every state write below re-checks the run id.
    const stillSamePlan = (current) => current.artifacts?.planRunId === planRunId;

    const failWith = (message) =>
      updateRun((current) =>
        stillSamePlan(current)
          ? { ...current, safetyAck: { ...current.safetyAck, pending: false, error: message } }
          : current
      );

    try {
      const response = await fetch(
        `/api/repair-plan/${encodeURIComponent(planRunId)}/safety-acknowledgment`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ acknowledged: nextAcknowledged }),
        }
      );

      if (!response.ok) {
        let message = "Could not record the acknowledgment.";
        try {
          const payload = await response.json();
          message = payload.error || message;
        } catch {
          // keep default message
        }
        failWith(message);
        return;
      }

      const payload = await response.json();

      updateRun((current) => {
        if (!stillSamePlan(current)) {
          return current;
        }

        return {
          ...current,
          artifacts: {
            ...current.artifacts,
            readiness: payload.readiness || current.artifacts.readiness,
            checklist: payload.checklist || current.artifacts.checklist,
          },
          safetyAck: {
            // The tick reflects what the server actually scored, not what was
            // requested, so the checkbox can never disagree with the rubric row.
            acknowledged: payload.readiness?.safetyAcknowledged === true,
            pending: false,
            error: "",
          },
        };
      });
    } catch (error) {
      failWith(error.message || "Could not record the acknowledgment.");
    }
  }

  function handleClear() {
    setForm(defaultForm);
    runRef.current = initialRun;
    setRun(initialRun);
  }

  function handleStop() {
    // The fetch's own catch block sees the resulting AbortError and returns
    // without touching state, so this is the only place run.status changes.
    abortRef.current?.abort();
    updateRun((current) =>
      current.status === "running"
        ? { ...current, status: "idle", statusMessage: "" }
        : current
    );
  }

  const artifacts = run.artifacts;

  return (
    <>
      <PageHeader
        title="Repair Planner"
        description="Turn a rough repair brief into a prioritized plan grounded in your uploaded manuals."
      />

      <div className="space-y-6">
        {/* Ahead of the form, and outside every run-dependent panel below, so the
            same warning is on screen whether the page is idle, streaming, done,
            or failed -- and is read before the owner acts on any of it. This is
            the general notice only: the per-plan hazard list and the
            acknowledgment checkbox live in ReadinessPanel and are unaffected by
            it. Nothing here acknowledges anything. */}
        <AiSafetyNotices
          disclosure={AI_DISCLOSURE_PLANNER}
          extraWarning={AI_PLANNER_LIMITS}
        />

        <SectionCard title="Describe the repair">
          <form className="space-y-4" onSubmit={handleSubmit}>
            <label className="grid gap-2 text-sm text-slate-700">
              <span className="font-medium text-slate-900">Repair brief</span>
              <textarea
                className="min-h-28 rounded-xl border border-slate-300 px-3 py-2 outline-none transition focus:border-sky-500"
                value={form.brief}
                onChange={(event) => setForm((current) => ({ ...current, brief: event.target.value }))}
                placeholder="Front brakes squeak when stopping. Coolant smell after long drives. Want to fix both this weekend."
              />
            </label>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="grid gap-2 text-sm text-slate-700">
                <span className="font-medium text-slate-900">Skill level</span>
                <select
                  className="rounded-xl border border-slate-300 px-3 py-2 outline-none transition focus:border-sky-500"
                  value={form.skillLevel}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, skillLevel: event.target.value }))
                  }
                >
                  <option value="beginner">Beginner</option>
                  <option value="intermediate">Intermediate</option>
                  <option value="advanced">Advanced</option>
                </select>
              </label>

              <label className="grid gap-2 text-sm text-slate-700">
                <span className="font-medium text-slate-900">Constraints</span>
                <input
                  className="rounded-xl border border-slate-300 px-3 py-2 outline-none transition focus:border-sky-500"
                  value={form.constraints}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, constraints: event.target.value }))
                  }
                  placeholder="Weekend only, under $200"
                />
              </label>

              <label className="grid gap-2 text-sm text-slate-700">
                <span className="font-medium text-slate-900">Available tools</span>
                <input
                  className="rounded-xl border border-slate-300 px-3 py-2 outline-none transition focus:border-sky-500"
                  value={form.availableTools}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, availableTools: event.target.value }))
                  }
                  placeholder="Socket set, jack, jack stands"
                />
              </label>

              <label className="grid gap-2 text-sm text-slate-700">
                <span className="font-medium text-slate-900">Available parts</span>
                <input
                  className="rounded-xl border border-slate-300 px-3 py-2 outline-none transition focus:border-sky-500"
                  value={form.availableParts}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, availableParts: event.target.value }))
                  }
                  placeholder="Front brake pads"
                />
              </label>
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                type="submit"
                disabled={isRunning}
                className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-600"
              >
                {isRunning ? "Planning..." : "Build repair plan"}
              </button>
              {isRunning ? (
                <button
                  type="button"
                  onClick={handleStop}
                  className="rounded-xl border border-red-300 px-4 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-50"
                >
                  Stop
                </button>
              ) : null}
              <button
                type="button"
                onClick={handleClear}
                className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
              >
                Clear
              </button>
            </div>
          </form>
        </SectionCard>

        <StatusBanner status={run.status} message={run.message} />
        <ActivityLog activity={run.activity} statusMessage={run.statusMessage} isRunning={isRunning} />
        <EvidencePanel
          evidenceStatus={run.evidenceStatus}
          evidence={run.artifacts?.evidence}
        />
        <NarrativePanel narrative={run.narrative} />
        <ReadinessPanel
          readiness={artifacts?.readiness}
          safetyAck={run.safetyAck}
          onAcknowledgeSafety={handleAcknowledgeSafety}
          canAcknowledge={Boolean(artifacts?.planRunId)}
        />
        <ChecklistPanel checklist={artifacts?.checklist} />
        <TasksPanel tasks={artifacts?.tasks} />
        <HandoffPanel handoffNotes={artifacts?.handoffNotes} />
        <SourcesPanel citations={artifacts?.citations} />
      </div>
    </>
  );
}
