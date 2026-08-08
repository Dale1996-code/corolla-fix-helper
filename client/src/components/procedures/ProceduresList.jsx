import { formatDate } from "../../lib/formatDate";
import { labelize } from "../../lib/labelize";
import { getDifficultyBadgeClass } from "./procedureDisplay";

// Same rebalance as SymptomsList: "Linked docs" grew to fit its own 108px
// header, Title grew because a procedure title is the column people scan,
// and System/Difficulty/Updated gave back width they never used.
// Tracks 224+96+104+112+112+120 = 768px, +5x12px gap +32px padding = 860px.
export const proceduresListTable = {
  name: "Procedures",
  gridClass:
    "grid grid-cols-[minmax(14rem,2.5fr)_minmax(6rem,1fr)_minmax(6.5rem,1fr)_minmax(7rem,1fr)_minmax(7rem,0.8fr)_minmax(7.5rem,1fr)] gap-3",
  minWidthClass: "min-w-[54rem]",
};

export function ProceduresList({
  procedures,
  totalProcedures,
  hasActiveFilters,
  selectedProcedureId,
  onSelectProcedure,
}) {
  const listGridClass = proceduresListTable.gridClass;

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <div className={proceduresListTable.minWidthClass}>
          <div
            className={`${listGridClass} border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-600`}
          >
            <span>Title</span>
            <span>System</span>
            <span>Difficulty</span>
            <span>Confidence</span>
            <span>Linked docs</span>
            <span>Updated</span>
          </div>

          {procedures.length === 0 ? (
            <div className="px-4 py-6 text-sm text-slate-600">
              {totalProcedures === 0 ? "No procedures saved yet." : null}
              {totalProcedures > 0 && hasActiveFilters
                ? "No procedures match the current filters."
                : null}
            </div>
          ) : null}

          {procedures.map((procedure) => {
            const isSelected = procedure.id === selectedProcedureId;

            return (
              <button
                key={procedure.id}
                type="button"
                aria-current={isSelected ? "true" : undefined}
                aria-label={`Select procedure: ${procedure.title}`}
                className={`${listGridClass} w-full items-center border-b border-slate-100 px-4 py-3 text-left text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500 ${
                  isSelected ? "bg-sky-50" : "hover:bg-slate-50"
                }`}
                onClick={() => onSelectProcedure(procedure.id)}
              >
                <span className="truncate font-medium text-slate-900">{procedure.title}</span>
                <span className="truncate text-slate-700">{procedure.system || "Not set"}</span>
                <span>
                  <span
                    className={`rounded-full px-2 py-1 text-xs font-semibold ${getDifficultyBadgeClass(procedure.difficulty)}`}
                  >
                    {labelize(procedure.difficulty)}
                  </span>
                </span>
                <span className="truncate text-slate-700">{labelize(procedure.confidence)}</span>
                <span className="text-slate-700">{procedure.linkedDocumentIds.length}</span>
                <span className="truncate text-xs text-slate-600">{formatDate(procedure.updatedAt)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
