export function PageHeader({ eyebrow, title, description }) {
  return (
    <header className="mb-7 border-b border-slate-300/70 pb-5">
      {eyebrow ? (
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
          {eyebrow}
        </p>
      ) : null}
      <h2 className="mt-2 text-[26px] font-bold tracking-tight text-slate-950">{title}</h2>
      {description ? (
        <p className="mt-3 max-w-4xl text-sm leading-6 text-slate-600">{description}</p>
      ) : null}
    </header>
  );
}
