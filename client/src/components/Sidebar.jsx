import { NavLink } from "react-router-dom";
import { navigationItems } from "../lib/navigation";

export function Sidebar() {
  return (
    <aside className="sticky top-0 hidden min-h-screen w-72 shrink-0 border-r border-slate-200 bg-white px-5 py-6 lg:block">
      <div className="mb-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
          Corolla Fix Helper
        </p>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">
          Local Repair Helper
        </h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Documents, symptoms, procedures, and notes for your 2009 Toyota Corolla LE 1.8L.
        </p>
      </div>

      <nav className="space-y-2">
        {navigationItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              [
                "block rounded-xl px-4 py-3 text-sm font-medium transition-colors",
                isActive
                  ? "bg-slate-900 text-white"
                  : "text-slate-700 hover:bg-slate-100 hover:text-slate-900",
              ].join(" ")
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
