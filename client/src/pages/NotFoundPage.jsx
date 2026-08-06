import { Link, useLocation } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";

// Catch-all page for the `path="*"` route in App.jsx. Without it an unmatched
// URL — a typo, a stale bookmark, or a link to a page that has since moved —
// rendered the chrome (sidebar and mobile nav) around a completely empty
// <main>, which reads as a broken app rather than a wrong address.
export function NotFoundPage() {
  const location = useLocation();

  return (
    <div>
      <PageHeader
        title="Page not found"
        description="That address does not match any page in this workspace. It was probably a typo or a bookmark from an older version of the app."
      />

      <p className="text-sm text-slate-600">
        Requested address:{" "}
        <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[0.8rem] text-slate-800">
          {`${location.pathname}${location.search}`}
        </code>
      </p>

      <Link
        to="/documents"
        className="mt-6 inline-block rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
      >
        Go to Documents
      </Link>
    </div>
  );
}
