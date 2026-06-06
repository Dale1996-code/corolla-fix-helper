import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
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
  message: "",
};

const READINESS_LABELS = {
  ready: { label: "Ready", className: "bg-emerald-100 text-emerald-800" },
  almost_ready: { label: "Almost ready", className: "bg-amber-100 text-amber-800" },
  not_ready: { label: "Not ready", className: "bg-red-100 text-red-800" },
};

function Card({ title, children }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function ActivityLog({ activity, statusMessage, isRunning }) {
  if (!activity.length && !statusMessage) {
    return null;
  }

  return (
    <Card title="Agent activity">
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
    </Card>
  );
}

function NarrativePanel({ narrative }) {
  if (!narrative) {
    return null;
  }

  return (
    <Card title="Prioritized plan">
      <p className="whitespace-pre-wrap text-sm leading-6 text-slate-700">{narrative}</p>
    </Card>
  );
}

function ReadinessPanel({ readiness }) {
  if (!readiness) {
    return null;
  }

  const badge = READINESS_LABELS[readiness.level] || READINESS_LABELS.not_ready;

  return (
    <Card title="Launch readiness">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-2xl font-bold text-slate-900">{readiness.score}/100</span>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${badge.className}`}>
          {badge.label}
        </span>
      </div>

      <ul className="space-y-2">
        {readiness.rubric.map((item) => (
          <li key={item.id} className="flex items-center gap-2 text-sm text-slate-700">
            <span aria-hidden="true">{item.met ? "✓" : "✗"}</span>
            <span>
              {item.label} ({item.points} pts)
            </span>
          </li>
        ))}
      </ul>

      {readiness.gaps.length ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <p className="font-semibold">Gaps to close</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {readiness.gaps.map((gap, index) => (
              <li key={index}>{gap}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

function ChecklistPanel({ checklist }) {
  if (!checklist?.length) {
    return null;
  }

  return (
    <Card title="Owner checklist">
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
            <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-slate-700">
              {item.steps.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
          </article>
        ))}
      </div>
    </Card>
  );
}

function TasksPanel({ tasks }) {
  if (!tasks?.length) {
    return null;
  }

  return (
    <Card title="Extracted tasks">
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
    </Card>
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
    <Card title="Handoff drafts">
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
    </Card>
  );
}

function SourcesPanel({ citations }) {
  if (!citations?.length) {
    return null;
  }

  return (
    <Card title="Sources">
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
    </Card>
  );
}

function StatusBanner({ status, message }) {
  if (status === "ai_not_configured") {
    return (
      <section className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        <p className="font-semibold">AI not configured</p>
        <p className="mt-2 text-amber-700">{message}</p>
      </section>
    );
  }

  if (status === "error") {
    return (
      <section className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        <p className="font-semibold text-red-800">Could not build the plan</p>
        <p className="mt-2">{message}</p>
      </section>
    );
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
    } else if (event.type === "text_delta") {
      updateRun((current) => ({ ...current, narrative: current.narrative + event.text }));
    } else if (event.type === "ai_not_configured") {
      updateRun((current) => ({ ...current, status: "ai_not_configured", message: event.message || "" }));
    } else if (event.type === "error") {
      updateRun((current) => ({ ...current, status: "error", message: event.message || "" }));
    } else if (event.type === "done") {
      updateRun((current) => ({
        ...current,
        status: current.status === "error" || current.status === "ai_not_configured" ? current.status : "done",
        artifacts: event.artifacts || current.artifacts,
        statusMessage: "",
      }));
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

    try {
      const response = await fetch("/api/repair-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, brief: trimmedBrief }),
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

      updateRun((current) =>
        current.status === "running" ? { ...current, status: "done", statusMessage: "" } : current
      );
    } catch (error) {
      updateRun((current) => ({
        ...current,
        status: "error",
        message: error.message || "Could not build the plan.",
      }));
    }
  }

  function handleClear() {
    setForm(defaultForm);
    runRef.current = initialRun;
    setRun(initialRun);
  }

  const artifacts = run.artifacts;

  return (
    <>
      <PageHeader
        eyebrow="Working Feature"
        title="Repair Planner"
        description="Turn a rough repair brief into a prioritized plan grounded in your uploaded manuals. The agent extracts tasks, checks readiness against a rubric, builds an owner checklist, and drafts handoff copy while streaming its progress."
      />

      <div className="space-y-6">
        <Card title="Describe the repair">
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
                className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                {isRunning ? "Planning..." : "Build repair plan"}
              </button>
              <button
                type="button"
                onClick={handleClear}
                className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
              >
                Clear
              </button>
            </div>
          </form>
        </Card>

        <StatusBanner status={run.status} message={run.message} />
        <ActivityLog activity={run.activity} statusMessage={run.statusMessage} isRunning={isRunning} />
        <NarrativePanel narrative={run.narrative} />
        <ReadinessPanel readiness={artifacts?.readiness} />
        <ChecklistPanel checklist={artifacts?.checklist} />
        <TasksPanel tasks={artifacts?.tasks} />
        <HandoffPanel handoffNotes={artifacts?.handoffNotes} />
        <SourcesPanel citations={artifacts?.citations} />
      </div>
    </>
  );
}
