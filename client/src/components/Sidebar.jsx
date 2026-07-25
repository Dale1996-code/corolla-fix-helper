import { NavLink } from "react-router-dom";
import { navigationItems } from "../lib/navigation";

export function Sidebar() {
  return (
    <aside className="editorial-sidebar sticky top-0 hidden min-h-screen w-72 shrink-0 border-r border-slate-300 px-5 py-6 text-white lg:flex lg:flex-col">
      <div className="mb-8 border-b border-white/10 pb-6">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-200">
            Corolla Fix Helper
          </p>
          <span className="font-display text-sm font-bold tracking-tight text-white">
            DaleTech
          </span>
        </div>
        <p className="mt-2 font-display text-[2rem] font-bold leading-none text-white">
          Local Repair Helper
        </p>
        <p className="mt-3 text-sm leading-6 text-slate-300">
          Documents, symptoms, procedures, and notes for your 2009 Toyota Corolla LE 1.8L.
        </p>
      </div>

      <nav className="space-y-1.5">
        {navigationItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              [
                "block rounded-lg border border-transparent px-4 py-3 text-sm font-semibold transition-colors",
                isActive
                  ? "bg-white text-slate-950 shadow-sm"
                  : "text-slate-300 hover:border-white/10 hover:bg-white/10 hover:text-white",
              ].join(" ")
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto rounded-lg border border-white/10 bg-white/5 p-4 text-xs leading-5 text-slate-300">
        <p className="font-semibold uppercase tracking-[0.18em] text-sky-200">Local workspace</p>
        <p className="mt-2">SQLite database and uploaded PDFs stay on this machine.</p>
      </div>
    </aside>
  );
}
