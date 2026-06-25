export function TagChips({ tags, size = "sm" }) {
  if (!tags.length) {
    return null;
  }

  const sizeClass = size === "xs" ? "text-[0.65rem] px-1.5 py-0.5" : "text-xs px-2 py-0.5";

  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <span
          key={tag}
          className={`rounded-full bg-sky-100 font-medium text-sky-900 ring-1 ring-sky-200 ${sizeClass}`}
        >
          #{tag}
        </span>
      ))}
    </div>
  );
}
