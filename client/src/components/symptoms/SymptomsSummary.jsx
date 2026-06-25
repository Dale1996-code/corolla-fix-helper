function SummaryCard({ label, value, tone = "slate" }) {
  const toneClass =
    tone === "open"
      ? "border-sky-200 bg-sky-50 text-sky-900"
      : tone === "monitoring"
        ? "border-amber-200 bg-amber-50 text-amber-900"
        : tone === "resolved"
          ? "border-emerald-200 bg-emerald-50 text-emerald-900"
          : "border-slate-200 bg-white text-slate-900";

  return (
    <div className={`rounded-xl border px-4 py-3 shadow-sm ${toneClass}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold">{value}</p>
    </div>
  );
}

export function SymptomsSummary({ totalCount, visibleCount, statusCounts }) {
  return (
    <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
      <SummaryCard label="Total symptoms" value={totalCount} />
      <SummaryCard label="Visible now" value={visibleCount} />
      <SummaryCard label="Open" value={statusCounts.open} tone="open" />
      <SummaryCard label="Monitoring" value={statusCounts.monitoring} tone="monitoring" />
      <SummaryCard label="Resolved" value={statusCounts.resolved} tone="resolved" />
    </section>
  );
}
