import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { Sidebar } from "./components/Sidebar";
import { DashboardPage } from "./pages/DashboardPage";
import { DocumentsPage } from "./pages/DocumentsPage";
import { SearchPage } from "./pages/SearchPage";
import { RepairPlannerPage } from "./pages/RepairPlannerPage";
import { SymptomsPage } from "./pages/SymptomsPage";
import { ProceduresPage } from "./pages/ProceduresPage";
import { NotesPage } from "./pages/NotesPage";
import { RepairChecklistsPage } from "./pages/RepairChecklistsPage";
import { RepairHistoryPage } from "./pages/RepairHistoryPage";
import { SettingsPage } from "./pages/SettingsPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { listDetailLayoutClasses } from "./components/ListDetailLayout";
import { navigationItems } from "./lib/navigation";
import { PRODUCT_NAME } from "./lib/pageTitle";

function MobileNav() {
  return (
    <header className="border-b border-slate-300 bg-white/90 px-4 py-4 lg:hidden">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-700">
          {PRODUCT_NAME}
        </p>
        <span className="font-display text-sm font-bold tracking-tight text-sky-900">
          DaleTech
        </span>
      </div>
      <nav className="mt-3 flex gap-2 overflow-x-auto pb-1" aria-label="Primary navigation">
        {navigationItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              [
                "shrink-0 rounded-full border px-3 py-2 text-sm font-semibold",
                isActive
                  ? "border-sky-300 bg-sky-100 text-sky-900"
                  : "border-slate-300 bg-white text-slate-700",
              ].join(" ")
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}

export default function App() {
  return (
    <div className="editorial-app min-h-screen text-ink-900">
      <MobileNav />
      {/* 104rem, not the old 88rem. With an 18rem sidebar and 4rem of padding
          on <main>, 88rem capped every page's content box at 66rem, so a wide
          monitor left hundreds of pixels of viewport empty while the list
          tables clipped ~28rem of columns. 104rem is the width at which the
          list/detail split fits both panes, so the class comes from
          ListDetailLayout -- the two describe the same measurement and cannot
          drift apart. */}
      <div className={`mx-auto flex min-h-screen ${listDetailLayoutClasses.appShellMaxWidth}`}>
        <Sidebar />

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <Routes>
            <Route path="/" element={<Navigate to="/documents" replace />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/documents" element={<DocumentsPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/repair-planner" element={<RepairPlannerPage />} />
            <Route path="/symptoms" element={<SymptomsPage />} />
            <Route path="/procedures" element={<ProceduresPage />} />
            <Route path="/notes" element={<NotesPage />} />
            <Route path="/repair-checklists" element={<RepairChecklistsPage />} />
            <Route path="/repair-history" element={<RepairHistoryPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
