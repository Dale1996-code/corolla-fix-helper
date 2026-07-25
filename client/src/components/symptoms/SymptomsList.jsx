import { formatDate } from "../../lib/formatDate";
import { labelize } from "../../lib/labelize";
import { getStatusBadgeClass } from "./symptomDisplay";

export function SymptomsList({
  symptoms,
  totalSymptoms,
  hasActiveFilters,
  selectedSymptomId,
  onSelectSymptom,
}) {
  const listGridClass =
    "grid grid-cols-[minmax(16rem,2.8fr)_minmax(7rem,1fr)_minmax(7rem,1fr)_minmax(7rem,1fr)_minmax(6rem,0.8fr)_minmax(9rem,1fr)] gap-3";

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <div className="min-w-[880px]">
          <div
            className={`${listGridClass} border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-600`}
          >
            <span>Title</span>
            <span>System</span>
            <span>Status</span>
            <span>Confidence</span>
            <span>Linked docs</span>
            <span>Updated</span>
          </div>

          {symptoms.length === 0 ? (
            <div className="px-4 py-8 text-sm text-slate-600">
              {totalSymptoms === 0 ? (
                <div className="space-y-2">
                  <p className="font-semibold text-slate-900">No symptoms saved yet.</p>
                  <p>Create your first symptom above to start tracking what the car is doing.</p>
                </div>
              ) : hasActiveFilters ? (
                <div className="space-y-2">
                  <p className="font-semibold text-slate-900">No symptoms match the current filters.</p>
                  <p>Change the filters or create a new symptom that matches what you want to track.</p>
                </div>
              ) : (
                <p>No symptoms are available right now.</p>
              )}
            </div>
          ) : null}

          {symptoms.map((symptom) => {
            const isSelected = symptom.id === selectedSymptomId;
            const secondaryText =
              symptom.description || symptom.suspectedCauses || "No extra details yet.";

            return (
              <button
                key={symptom.id}
                type="button"
                className={`${listGridClass} w-full cursor-pointer border-b border-slate-100 px-4 py-3 text-left text-sm ${
                  isSelected ? "bg-sky-50" : "hover:bg-slate-50"
                }`}
                onClick={() => onSelectSymptom(symptom.id)}
              >
                <span>
                  <span data-testid="symptom-row-title" className="block truncate font-medium text-slate-900">
                    {symptom.title}
                  </span>
                  <span className="mt-1 block truncate text-xs text-slate-500">{secondaryText}</span>
                </span>
                <span className="truncate text-slate-700">{symptom.system || "Not set"}</span>
                <span>
                  <span
                    className={`rounded-full px-2 py-1 text-xs font-semibold ${getStatusBadgeClass(symptom.status)}`}
                  >
                    {labelize(symptom.status)}
                  </span>
                </span>
                <span className="truncate text-slate-700">{labelize(symptom.confidence)}</span>
                <span className="text-slate-700">{symptom.linkedDocumentIds.length}</span>
                <span className="text-xs text-slate-600">{formatDate(symptom.updatedAt)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
