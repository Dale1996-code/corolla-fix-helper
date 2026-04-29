import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { buildEntityLink } from "../lib/navigation";

const emptyDashboardData = {
  vehicle: null,
  summary: {
    totalDocuments: 0,
    favoriteDocuments: 0,
    totalSymptoms: 0,
    activeSymptoms: 0,
    totalProcedures: 0,
    totalNotes: 0,
  },
  favoriteDocuments: [],
  recentDocuments: [],
  recentSymptoms: [],
  recentProcedures: [],
  recentNotes: [],
  activeSymptoms: [],
  recentActivity: [],
};

function formatVehicleProfile(vehicle) {
  if (!vehicle) {
    return "Vehicle profile not set";
  }

  return [vehicle.year, vehicle.make, vehicle.model, vehicle.trim, vehicle.engine]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
}

const quickActions = [
  {
    label: "Upload document",
    description: "Import one PDF into your local document library.",
    to: "/documents#document-upload",
  },
  {
    label: "Open Documents",
    description: "Go to the document list and detail view.",
    to: "/documents#document-library",
  },
  {
    label: "Open Search",
    description: "Search documents, symptoms, procedures, and notes from one page.",
    to: "/search",
  },
  {
    label: "Add Symptom",
    description: "Log what the car is doing right now.",
    to: "/symptoms#create-symptom",
  },
  {
    label: "Add Procedure",
    description: "Save a repair process or checklist.",
    to: "/procedures#create-procedure",
  },
  {
    label: "Add Note",
    description: "Write down a quick observation or reminder.",
    to: "/notes#create-note",
  },
];

function formatDate(value) {
  if (!value) {
    return "Not available";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Not available";
  }

  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function labelize(value) {
  if (!value) {
    return "Not set";
  }

  return String(value)
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getSymptomStatusBadgeClass(status) {
  if (status === "resolved") {
    return "bg-emerald-100 text-emerald-800";
  }

  if (status === "monitoring") {
    return "bg-amber-100 text-amber-800";
  }

  return "bg-slate-100 text-slate-700";
}

function SummaryCard({ label, value, helperText }) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold text-slate-900">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{helperText}</p>
    </article>
  );
}

function QuickActions({ vehicle }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">Quick actions</h3>
          <p className="mt-1 text-sm text-slate-600">
            Jump straight into the next useful task.
          </p>
        </div>

        <p className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
          {formatVehicleProfile(vehicle)}
        </p>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
        {quickActions.map((action) => (
          <Link
            key={action.label}
            to={action.to}
            className="rounded-lg border border-slate-300 bg-white p-4 transition hover:border-slate-400 hover:bg-slate-50"
          >
            <p className="text-sm font-semibold text-slate-900">{action.label}</p>
            <p className="mt-1 text-xs leading-5 text-slate-600">{action.description}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}

function SectionCard({
  title,
  description,
  actionLabel = "",
  actionTo = "",
  className = "",
  children,
}) {
  return (
    <section className={`rounded-xl border border-slate-200 bg-white p-5 shadow-sm ${className}`.trim()}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
          <p className="mt-1 text-sm text-slate-600">{description}</p>
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

      <div className="mt-4">{children}</div>
    </section>
  );
}

function EmptyState({ message }) {
  return <p className="text-sm text-slate-600">{message}</p>;
}

function DashboardAction({ action }) {
  const className =
    "rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-100";

  if (action.href) {
    return (
      <a
        key={action.label}
        href={action.href}
        target={action.external ? "_blank" : undefined}
        rel={action.external ? "noreferrer" : undefined}
        className={className}
      >
        {action.label}
      </a>
    );
  }

  return (
    <Link key={action.label} to={action.to} className={className}>
      {action.label}
    </Link>
  );
}

function DashboardItem({
  title,
  meta = "",
  timestamp = "",
  badge = "",
  badgeClassName = "bg-slate-100 text-slate-700",
  actions = [],
}) {
  return (
    <li className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900">{title}</p>
          {meta ? <p className="mt-1 text-xs text-slate-500">{meta}</p> : null}
          {timestamp ? <p className="mt-1 text-xs text-slate-500">{timestamp}</p> : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {badge ? (
            <span className={`rounded-full px-2 py-1 text-xs font-semibold ${badgeClassName}`}>
              {badge}
            </span>
          ) : null}

          {actions.map((action) => (
            <DashboardAction key={`${title}-${action.label}`} action={action} />
          ))}
        </div>
      </div>
    </li>
  );
}

function FavoriteDocumentsSection({ documents }) {
  if (!documents.length) {
    return <EmptyState message="No favorite documents yet." />;
  }

  return (
    <ul className="space-y-2">
      {documents.map((document) => (
        <DashboardItem
          key={document.id}
          title={document.title}
          meta={`${document.system || "No system"} - ${document.documentType || "No type"}`}
          timestamp={`Updated ${formatDate(document.updatedAt || document.createdAt)}`}
          badge="Favorite"
          badgeClassName="bg-amber-100 text-amber-800"
          actions={[
            {
              label: "View",
              to: buildEntityLink("document", document.id),
            },
            {
              label: "Open file",
              href: `/api/documents/${document.id}/file`,
              external: true,
            },
          ]}
        />
      ))}
    </ul>
  );
}

function RecentDocumentsSection({ documents }) {
  if (!documents.length) {
    return <EmptyState message="No documents yet." />;
  }

  return (
    <ul className="space-y-2">
      {documents.map((document) => (
        <DashboardItem
          key={document.id}
          title={document.title}
          meta={`${document.system || "No system"} - ${document.documentType || "No type"}`}
          timestamp={`Updated ${formatDate(document.updatedAt || document.createdAt)}`}
          badge={document.isFavorite ? "Favorite" : ""}
          badgeClassName="bg-amber-100 text-amber-800"
          actions={[
            {
              label: "View",
              to: buildEntityLink("document", document.id),
            },
            {
              label: "Open file",
              href: `/api/documents/${document.id}/file`,
              external: true,
            },
          ]}
        />
      ))}
    </ul>
  );
}

function RecentEntitySection({
  items,
  entityType,
  emptyMessage,
  buildMeta,
  buildBadge,
}) {
  if (!items.length) {
    return <EmptyState message={emptyMessage} />;
  }

  return (
    <ul className="space-y-2">
      {items.map((item) => {
        const badge = buildBadge ? buildBadge(item) : null;

        return (
          <DashboardItem
            key={item.id}
            title={item.title}
            meta={buildMeta(item)}
            timestamp={`Updated ${formatDate(item.updatedAt || item.createdAt)}`}
            badge={badge?.label || ""}
            badgeClassName={badge?.className || "bg-slate-100 text-slate-700"}
            actions={[
              {
                label: "View",
                to: buildEntityLink(entityType, item.id),
              },
            ]}
          />
        );
      })}
    </ul>
  );
}

function ActiveSymptomsSection({ items }) {
  if (!items.length) {
    return <EmptyState message="No active symptoms." />;
  }

  return (
    <ul className="space-y-2">
      {items.map((symptom) => (
        <DashboardItem
          key={symptom.id}
          title={symptom.title}
          meta={symptom.system || "No system"}
          timestamp={`Updated ${formatDate(symptom.updatedAt || symptom.createdAt)}`}
          badge={labelize(symptom.status)}
          badgeClassName={getSymptomStatusBadgeClass(symptom.status)}
          actions={[
            {
              label: "View",
              to: buildEntityLink("symptom", symptom.id),
            },
          ]}
        />
      ))}
    </ul>
  );
}

function RecentActivitySection({ items }) {
  if (!items.length) {
    return <EmptyState message="No recent activity yet." />;
  }

  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <DashboardItem
          key={item.key}
          title={item.title}
          meta={`Latest ${item.typeLabel.toLowerCase()} update`}
          timestamp={formatDate(item.updatedAt)}
          badge={item.typeLabel}
          actions={[
            {
              label: "Open",
              to: buildEntityLink(item.entityType, item.entityId),
            },
          ]}
        />
      ))}
    </ul>
  );
}

function getNoteMeta(note) {
  const noteType = labelize(note.noteType);
  const relatedEntityType =
    note.relatedEntityType === "none"
      ? "No linked item"
      : `Linked to ${labelize(note.relatedEntityType)}`;

  return `${noteType} - ${relatedEntityType}`;
}

export function DashboardPage() {
  const [dashboardData, setDashboardData] = useState(emptyDashboardData);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    async function loadDashboardData() {
      try {
        setLoadError("");
        setLoading(true);

        const response = await fetch("/api/dashboard");
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(payload.error || "Could not load dashboard data.");
        }

        setDashboardData({
          vehicle: payload.vehicle || null,
          summary: {
            ...emptyDashboardData.summary,
            ...(payload.summary || {}),
          },
          favoriteDocuments: Array.isArray(payload.favoriteDocuments)
            ? payload.favoriteDocuments
            : [],
          recentDocuments: Array.isArray(payload.recentDocuments)
            ? payload.recentDocuments
            : [],
          recentSymptoms: Array.isArray(payload.recentSymptoms)
            ? payload.recentSymptoms
            : [],
          recentProcedures: Array.isArray(payload.recentProcedures)
            ? payload.recentProcedures
            : [],
          recentNotes: Array.isArray(payload.recentNotes) ? payload.recentNotes : [],
          activeSymptoms: Array.isArray(payload.activeSymptoms)
            ? payload.activeSymptoms
            : [],
          recentActivity: Array.isArray(payload.recentActivity)
            ? payload.recentActivity
            : [],
        });
      } catch (error) {
        setLoadError(error.message || "Could not load dashboard data.");
      } finally {
        setLoading(false);
      }
    }

    loadDashboardData();
  }, []);

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Dashboard"
        description="See favorites, recent work, and active repair items at a glance so you can open the next thing you need without hunting through the app."
      />

      <div className="space-y-6">
        {loading ? (
          <section className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
            Loading dashboard...
          </section>
        ) : null}

        {loadError ? (
          <section className="rounded-xl border border-red-200 bg-red-50 p-6 shadow-sm">
            <p className="font-semibold text-red-800">Could not load dashboard.</p>
            <p className="mt-2 text-sm text-red-700">{loadError}</p>
          </section>
        ) : null}

        {!loading && !loadError ? (
          <>
            <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <SummaryCard
                label="Documents"
                value={dashboardData.summary.totalDocuments}
                helperText="Imported repair files in your library."
              />
              <SummaryCard
                label="Favorites"
                value={dashboardData.summary.favoriteDocuments}
                helperText="Starred documents for quick access."
              />
              <SummaryCard
                label="Symptoms"
                value={dashboardData.summary.totalSymptoms}
                helperText="Saved symptom records for this Corolla."
              />
              <SummaryCard
                label="Active Symptoms"
                value={dashboardData.summary.activeSymptoms}
                helperText="Open or monitoring issues right now."
              />
              <SummaryCard
                label="Procedures"
                value={dashboardData.summary.totalProcedures}
                helperText="Saved repair procedures and checklists."
              />
              <SummaryCard
                label="Notes"
                value={dashboardData.summary.totalNotes}
                helperText="Observations, reminders, and repair logs."
              />
            </section>

            <QuickActions vehicle={dashboardData.vehicle} />

            <div className="grid gap-6 xl:grid-cols-2">
              <SectionCard
                title="Favorite Documents"
                description="Your starred references for quick access while working."
                actionLabel="Open favorites"
                actionTo="/documents?favorite=favorites_only#document-library"
              >
                <FavoriteDocumentsSection documents={dashboardData.favoriteDocuments} />
              </SectionCard>

              <SectionCard
                title="Active Symptoms"
                description="Symptoms that are still open or being monitored."
                actionLabel="Open symptoms"
                actionTo="/symptoms#symptom-library"
              >
                <ActiveSymptomsSection items={dashboardData.activeSymptoms} />
              </SectionCard>

              <SectionCard
                title="Recent Activity"
                description="Latest changes across documents, symptoms, procedures, and notes."
                className="xl:col-span-2"
              >
                <RecentActivitySection items={dashboardData.recentActivity} />
              </SectionCard>

              <SectionCard
                title="Recent Documents"
                description="Most recently updated repair documents."
                actionLabel="Open documents"
                actionTo="/documents#document-library"
              >
                <RecentDocumentsSection documents={dashboardData.recentDocuments} />
              </SectionCard>

              <SectionCard
                title="Recent Symptoms"
                description="Recently touched symptom records."
                actionLabel="Open symptoms"
                actionTo="/symptoms#symptom-library"
              >
                <RecentEntitySection
                  items={dashboardData.recentSymptoms}
                  entityType="symptom"
                  emptyMessage="No symptoms yet."
                  buildMeta={(symptom) =>
                    `${symptom.system || "No system"} - ${labelize(symptom.status)}`
                  }
                  buildBadge={(symptom) => ({
                    label: labelize(symptom.status),
                    className: getSymptomStatusBadgeClass(symptom.status),
                  })}
                />
              </SectionCard>

              <SectionCard
                title="Recent Procedures"
                description="Recently updated repair procedures."
                actionLabel="Open procedures"
                actionTo="/procedures#procedure-library"
              >
                <RecentEntitySection
                  items={dashboardData.recentProcedures}
                  entityType="procedure"
                  emptyMessage="No procedures yet."
                  buildMeta={(procedure) =>
                    `${procedure.system || "No system"} - ${labelize(procedure.difficulty)} difficulty`
                  }
                  buildBadge={(procedure) => ({
                    label: labelize(procedure.confidence),
                    className: "bg-sky-100 text-sky-800",
                  })}
                />
              </SectionCard>

              <SectionCard
                title="Recent Notes"
                description="Latest observations, reminders, and repair notes."
                actionLabel="Open notes"
                actionTo="/notes#note-library"
              >
                <RecentEntitySection
                  items={dashboardData.recentNotes}
                  entityType="note"
                  emptyMessage="No notes yet."
                  buildMeta={(note) => getNoteMeta(note)}
                />
              </SectionCard>
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}
