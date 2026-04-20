export function PlaceholderPanel({ message, nextStep }) {
  return (
    <section className="rounded-2xl border border-dashed border-slate-300 bg-white p-6 shadow-sm">
      <p className="text-base font-medium text-slate-900">{message}</p>
      <p className="mt-3 text-sm leading-6 text-slate-600">{nextStep}</p>
    </section>
  );
}
