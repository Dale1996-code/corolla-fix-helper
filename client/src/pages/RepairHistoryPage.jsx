import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { ListDetailLayout } from "../components/ListDetailLayout";
import { ErrorBanner } from "../components/feedback/Banner";
import { formatCalendarDate, formatDate } from "../lib/formatDate";
import { formatLibraryTotal } from "../lib/resultRange";
import { buildDocumentFileLink, buildEntityLink, documentSourceName } from "../lib/navigation";
import { formatOdometerMiles, repairOutcomeLabel } from "../lib/repairHistory";
import { useScrollToHash } from "../lib/useScrollToHash";
import { applyParamUpdates, readIdParam, resolveSelectedRecord } from "../lib/urlState";

// The owner-facing half of roadmap N3: what work was actually done, when, at
// what mileage, why, and which manual pages backed it.
//
// A READ SURFACE, deliberately. The N3.1 API has full CRUD, but the way a
// repair gets recorded is by completing a checklist on the Repair Checklists
// page -- that is where the evidence already lives, and completion is what
// copies it here. A second, hand-typed "create a repair" form on this page
// would be a way to write a record with no provenance at all, which is the one
// thing this whole chain exists to prevent.
//
// THE SNAPSHOT RULE runs through every field below. A repair record carries
// both a live foreign key and a frozen title for its symptom, its checklist,
// and each of its source documents. The snapshot is what is DISPLAYED; the live
// id only decides whether there is also something to open. Substituting a
// current title for a snapshot would let a rename silently rewrite history,
// which is exactly what N3.1 built the snapshot columns to stop.

const OUTCOME_BADGE_CLASSES = {
  fixed: "bg-emerald-100 text-emerald-800",
  partial: "bg-amber-100 text-amber-800",
  not_fixed: "bg-red-100 text-red-800",
  unknown: "bg-slate-100 text-slate-700",
};

function outcomeBadgeClass(outcome) {
  return OUTCOME_BADGE_CLASSES[outcome] || OUTCOME_BADGE_CLASSES.unknown;
}

function OutcomeBadge({ outcome }) {
  return (
    <span
      className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${outcomeBadgeClass(outcome)}`}
    >
      {repairOutcomeLabel(outcome)}
    </span>
  );
}

// Repair (224) + Performed (112) + Odometer (128) + Outcome (128) = 592px,
// +3x12px gap +32px padding = 660px.
//
// Exported as one named definition for the same reason the other four lists
// are: `listTableWidths.test.js` measures the element this page actually
// renders rather than guessing at the first arbitrary width in a long file.
export const repairHistoryListTable = {
  name: "RepairHistory",
  gridClass:
    "grid grid-cols-[minmax(14rem,2.4fr)_minmax(7rem,1fr)_minmax(8rem,1fr)_minmax(8rem,1fr)] gap-3",
  minWidthClass: "min-w-[42rem]",
};

function RepairHistoryList({ records, selectedRecordId, onSelectRecord }) {
  const listGridClass = repairHistoryListTable.gridClass;

  return (
    <section
      id="repair-history-library"
      className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <div className="overflow-x-auto">
        <div className={repairHistoryListTable.minWidthClass}>
          <div
            className={`${listGridClass} border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-600`}
          >
            <span>Repair</span>
            <span>Performed</span>
            <span>Odometer</span>
            <span>Outcome</span>
          </div>

          {records.length === 0 ? (
            <div className="space-y-2 px-4 py-8 text-sm text-slate-600">
              <p className="font-semibold text-slate-900">No repairs recorded yet.</p>
              <p>
                Repair history is written by completing a checklist. Open a checklist on the Repair
                Checklists page and choose Record completed repair, and the job appears here with
                the documents that backed it.
              </p>
            </div>
          ) : null}

          {records.map((record) => {
            const isSelected = record.id === selectedRecordId;

            return (
              <button
                key={record.id}
                type="button"
                aria-current={isSelected ? "true" : undefined}
                aria-label={`Select repair: ${record.title}`}
                className={`${listGridClass} w-full items-center border-b border-slate-100 px-4 py-3 text-left text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500 ${
                  isSelected ? "bg-sky-50" : "hover:bg-slate-50"
                }`}
                onClick={() => onSelectRecord(record.id)}
              >
                <span className="truncate font-medium text-slate-900">{record.title}</span>
                <span className="truncate text-slate-700">
                  {formatCalendarDate(record.performedOn)}
                </span>
                <span className="truncate text-slate-700">
                  {formatOdometerMiles(record.odometerMiles)}
                </span>
                <span className="truncate text-slate-700">{repairOutcomeLabel(record.outcome)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// One cited page of one document.
//
// The href is built by `buildDocumentFileLink` from the server's validated
// numeric id and page number, exactly as an Ask AI citation is -- never from the
// title, which is a snapshot string and has no business steering a URL.
//
// When `documentId` is null the document has been deleted from the library. The
// snapshot still says what was consulted and on which page, so it is shown in
// full; what it does not get is a link, because there is nothing to open and a
// dead link would be a worse answer than an honest sentence.
function RepairSourceCard({ source }) {
  const documentName = documentSourceName(source);
  const pageLabel = source.pageNumber ? `Page ${source.pageNumber}` : "Page unknown";
  const fileUrl = buildDocumentFileLink(source.documentId, source.pageNumber);

  return (
    <li className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="min-w-0 font-semibold text-slate-900">{documentName}</p>
        {/* Kept visible even when the PDF opens at the page: a viewer that
            ignores the #page fragment leaves the owner to find it by hand. */}
        <span className="shrink-0 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
          {pageLabel}
        </span>
      </div>

      {fileUrl ? (
        <a
          href={fileUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={
            source.pageNumber
              ? `Open ${documentName} at page ${source.pageNumber} (PDF opens in a new tab)`
              : `Open ${documentName} (PDF opens in a new tab)`
          }
          className="mt-3 inline-flex text-sm font-medium text-sky-700 underline decoration-sky-200 underline-offset-2 hover:text-sky-900"
        >
          {source.pageNumber ? "Open cited page" : "Open document"}
        </a>
      ) : (
        <p className="mt-3 text-xs font-medium text-slate-500">
          This document is no longer in your library, so it cannot be opened. The title and page
          above are the record of what was consulted.
        </p>
      )}
    </li>
  );
}

// A historical link: the frozen title, plus a way through to the live record
// only while one exists.
function SnapshotLink({ title, entityType, entityId, openLabel, missingText }) {
  if (!title) {
    return <span className="text-slate-700">{missingText}</span>;
  }

  if (!entityId) {
    return (
      <>
        <span className="text-slate-700">{title}</span>
        <span className="block text-xs text-slate-500">
          No longer in your workspace — this is the name recorded at the time.
        </span>
      </>
    );
  }

  return (
    <Link
      className="font-medium text-sky-700 underline decoration-sky-200 underline-offset-2 hover:text-sky-900"
      to={buildEntityLink(entityType, entityId)}
      aria-label={`Open ${openLabel} ${title}`}
    >
      {title}
    </Link>
  );
}

function RepairHistoryDetails({ record }) {
  if (!record) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
        Select a repair to see what was done and which documents backed it.
      </section>
    );
  }

  const sources = Array.isArray(record.sources) ? record.sources : [];

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">{record.title}</h2>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <OutcomeBadge outcome={record.outcome} />
          <span className="text-xs text-slate-500">
            Performed {formatCalendarDate(record.performedOn)}
          </span>
        </div>
        <p className="mt-2 text-sm text-slate-500">Recorded {formatDate(record.createdAt)}</p>
      </div>

      <dl className="mt-5 grid gap-3 text-sm md:grid-cols-2">
        <div>
          <dt className="font-semibold text-slate-900">Performed</dt>
          <dd className="text-slate-700">{formatCalendarDate(record.performedOn)}</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-900">Odometer</dt>
          <dd className="text-slate-700">{formatOdometerMiles(record.odometerMiles)}</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-900">Outcome</dt>
          <dd className="text-slate-700">{repairOutcomeLabel(record.outcome)}</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-900">Symptom</dt>
          <dd>
            <SnapshotLink
              title={record.symptomTitle}
              entityType="symptom"
              entityId={record.symptomId}
              openLabel="symptom"
              missingText="No symptom linked"
            />
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-900">Checklist followed</dt>
          <dd>
            <SnapshotLink
              title={record.checklistTitle}
              entityType="checklist"
              entityId={record.checklistId}
              openLabel="checklist"
              missingText="No checklist recorded"
            />
          </dd>
        </div>
      </dl>

      <div className="mt-5 space-y-4 text-sm">
        <div>
          <h3 className="font-semibold text-slate-900">What was done</h3>
          <p className="mt-2 whitespace-pre-wrap text-slate-700">
            {record.summary || "Nothing was written down for this repair."}
          </p>
        </div>

        <div>
          <h3 className="font-semibold text-slate-900">Follow-up</h3>
          <p className="mt-2 whitespace-pre-wrap text-slate-700">
            {record.followUp || "No follow-up noted."}
          </p>
        </div>
      </div>

      <div className="mt-5">
        <h3 className="text-sm font-semibold text-slate-900">Source documents</h3>
        {sources.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">
            No documents were recorded for this repair. A repair completed from a plan-built
            checklist carries the pages that backed it.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {sources.map((source) => (
              <RepairSourceCard key={source.id} source={source} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function RepairHistoryPage() {
  useScrollToHash();

  // `?repairHistoryId=` is where the open repair lives, so Back returns to the
  // repair that was open rather than to the newest one, and a link to a single
  // repair -- the one the Repair Checklists page hands over after a completion
  // -- opens exactly that record. It only names a row; the record itself is
  // still loaded from the server, so an id that names nothing falls back to the
  // newest repair and then drops out of the URL.
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedRecordId = readIdParam(searchParams, "repairHistoryId");

  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  // There is no filter on this page, so everything loaded is everything
  // visible; the shared resolver still owns the precedence so this page cannot
  // drift from the other four.
  const selectedRecord = useMemo(
    () => resolveSelectedRecord(requestedRecordId, records, records),
    [requestedRecordId, records]
  );
  const selectedRecordId = selectedRecord?.id ?? null;

  const updateViewParams = useCallback(
    (updates, { replace = false } = {}) => {
      setSearchParams((currentParams) => applyParamUpdates(currentParams, updates), { replace });
    },
    [setSearchParams]
  );

  useEffect(() => {
    let cancelled = false;

    async function loadRepairHistory() {
      try {
        setLoadError("");
        setLoading(true);

        const response = await fetch("/api/repair-history");
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(payload.error || "Could not load repair history.");
        }

        if (!cancelled) {
          // The server orders by the day the work happened, newest first. That
          // order is kept as sent rather than re-sorted here: a second sorting
          // model in the browser is how a list starts disagreeing with the
          // paging and the counts that describe it.
          setRecords(Array.isArray(payload.repairHistory) ? payload.repairHistory : []);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(error.message || "Could not load repair history.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadRepairHistory();

    return () => {
      cancelled = true;
    };
  }, []);

  // A `repairHistoryId` naming a record that is not there -- deleted, or a
  // hand-typed link -- drops out of the URL after the newest repair has been
  // shown in its place, so the address stops describing a view that does not
  // exist. Replace, not push: normalizing is not a step to press Back through.
  useEffect(() => {
    if (loading || loadError || !searchParams.has("repairHistoryId")) {
      return;
    }

    const namesALoadedRecord =
      requestedRecordId && records.some((record) => record.id === requestedRecordId);

    if (!namesALoadedRecord) {
      updateViewParams({ repairHistoryId: null }, { replace: true });
    }
  }, [loading, loadError, requestedRecordId, records, searchParams, updateViewParams]);

  function handleSelectRecord(recordId) {
    // Picking a repair is a real navigation step, so it pushes: Back returns to
    // the repair that was open before.
    updateViewParams({ repairHistoryId: recordId });
  }

  return (
    <>
      <PageHeader
        title="Repair History"
        description="Every repair you have recorded — when it was done, the mileage, how it turned out, and the document pages that backed it."
      />

      <div className="space-y-6">
        {loading ? (
          <section className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
            Loading repair history...
          </section>
        ) : null}

        {loadError ? (
          <ErrorBanner title="Could not load repair history." className="shadow-sm">
            {loadError}
          </ErrorBanner>
        ) : null}

        {!loading && !loadError ? (
          <>
            {/* Every recorded repair is always on screen -- there is no filter
                and no paging here -- so this is the library-total form, not a
                range that would only restate its own total. */}
            <section className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm">
              {formatLibraryTotal({
                total: records.length,
                noun: "repair",
                nounPlural: "repairs",
                emptyText: "No repairs recorded yet.",
              })}
            </section>

            <ListDetailLayout
              selectedId={selectedRecordId}
              list={
                <RepairHistoryList
                  records={records}
                  selectedRecordId={selectedRecordId}
                  onSelectRecord={handleSelectRecord}
                />
              }
              detail={<RepairHistoryDetails record={selectedRecord} />}
            />
          </>
        ) : null}
      </div>
    </>
  );
}
