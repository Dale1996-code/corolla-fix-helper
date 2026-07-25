export function PageHeader({
  title,
  description,
  titleSizeClassName = "text-[2.1rem] lg:text-[2.55rem]",
}) {
  return (
    <header className="mb-8 border-b border-slate-300/70 pb-6">
      <h1
        className={`mt-2 ${titleSizeClassName} font-bold leading-none tracking-tight text-slate-950`}
      >
        {title}
      </h1>
      {description ? (
        <p className="mt-4 max-w-4xl text-[0.95rem] leading-7 text-slate-600">{description}</p>
      ) : null}
    </header>
  );
}
