import { useEffect } from "react";
import { formatPageTitle } from "../lib/pageTitle";

// Every page renders exactly one PageHeader, so this is also the one place that
// can keep the browser tab title and the page's own <h1> from drifting apart:
// the tab title is derived from the same `title` prop the heading renders,
// which makes "Documents | Corolla Fix Helper" structurally impossible to get
// wrong once the heading is right. Setting it from a route table instead would
// reintroduce the two-lists problem the H5 audit is about.
export function PageHeader({
  title,
  description,
  titleSizeClassName = "text-[2.1rem] lg:text-[2.55rem]",
}) {
  useEffect(() => {
    document.title = formatPageTitle(title);
  }, [title]);

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
