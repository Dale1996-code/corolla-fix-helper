// Shared inline feedback banners. Bundling the ARIA role with the styling
// keeps the two from drifting apart the way the hand-rolled copies had:
// error/success text was rendered with no announcement to screen readers.

const TONE_CLASSES = {
  slate: "border-slate-200 bg-slate-50 text-slate-600",
  amber: "border-amber-200 bg-amber-50 text-amber-800",
};

export function ErrorBanner({ title, children, className = "" }) {
  return (
    <div
      role="alert"
      className={`rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 ${className}`.trim()}
    >
      {title ? <p className="font-semibold text-red-800">{title}</p> : null}
      {title ? <p className="mt-2">{children}</p> : children}
    </div>
  );
}

export function SuccessBanner({ children, className = "" }) {
  return (
    <div
      role="status"
      className={`rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 ${className}`.trim()}
    >
      {children}
    </div>
  );
}

export function InfoBanner({ tone = "slate", title, announce = false, children, className = "" }) {
  const toneClass = TONE_CLASSES[tone] || TONE_CLASSES.slate;

  return (
    <div
      role={announce ? "status" : undefined}
      className={`rounded-xl border px-4 py-3 text-sm ${toneClass} ${className}`.trim()}
    >
      {title ? <p className="font-semibold">{title}</p> : null}
      {title ? <p className={title ? "mt-2" : undefined}>{children}</p> : children}
    </div>
  );
}
