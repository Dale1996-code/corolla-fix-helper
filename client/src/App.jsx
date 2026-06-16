import { Navigate, Route, Routes } from "react-router-dom";
import { Sidebar } from "./components/Sidebar";
import { DashboardPage } from "./pages/DashboardPage";
import { DocumentsPage } from "./pages/DocumentsPage";
import { SearchPage } from "./pages/SearchPage";
import { RepairPlannerPage } from "./pages/RepairPlannerPage";
import { SymptomsPage } from "./pages/SymptomsPage";
import { ProceduresPage } from "./pages/ProceduresPage";
import { NotesPage } from "./pages/NotesPage";
import { SettingsPage } from "./pages/SettingsPage";

export default function App() {
  return (
    <div className="min-h-screen bg-[#eef2f4] text-slate-950">
      <div className="mx-auto flex min-h-screen max-w-[88rem]">
        <Sidebar />

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-7">
          <Routes>
            <Route path="/" element={<Navigate to="/documents" replace />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/documents" element={<DocumentsPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/repair-planner" element={<RepairPlannerPage />} />
            <Route path="/symptoms" element={<SymptomsPage />} />
            <Route path="/procedures" element={<ProceduresPage />} />
            <Route path="/notes" element={<NotesPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
