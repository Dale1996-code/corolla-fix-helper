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
import { SettingsPage } from "./pages/SettingsPage";
import { navigationItems } from "./lib/navigation";

function MobileNav() {
  return (
    <header className="border-b border-slate-300 bg-white/90 px-4 py-4 lg:hidden">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-700">
          Corolla Fix Helper
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
      <div className="mx-auto flex min-h-screen max-w-[88rem]">
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
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
