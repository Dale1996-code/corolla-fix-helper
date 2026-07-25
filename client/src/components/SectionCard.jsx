import { Link } from "react-router-dom";

// Titled card shell for a page section. Previously duplicated byte-for-byte
// as SearchPage's SectionShell and RepairPlannerPage's Card, plus a third,
// slightly richer copy on DashboardPage (description + an optional action
// link) — folded in here via optional props.
export function SectionCard({
  title,
  description = "",
  actionLabel = "",
  actionTo = "",
  className = "",
  children,
}) {
  return (
    <section className={`rounded-2xl border border-slate-200 bg-white p-5 shadow-sm ${className}`.trim()}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          {description ? <p className="mt-1 text-sm text-slate-600">{description}</p> : null}
        </div>

        {actionLabel && actionTo ? (
          <Link
            to={actionTo}
            className="rounded-md border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-100"
          >
            {actionLabel}
          </Link>
        ) : null}
      </div>

      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}
