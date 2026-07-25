import { useEffect } from "react";
import { useLocation } from "react-router-dom";

// Scrolls the element matching the current URL's #hash into view. React
// Router does not do this on navigation (unlike a full page load), so the
// deep links built by buildEntityLink() — e.g. an Ask AI citation click —
// landed the user at the top of the page instead of at the record itself.
export function useScrollToHash() {
  const { hash } = useLocation();

  useEffect(() => {
    if (!hash) {
      return;
    }

    const target = document.getElementById(hash.slice(1));

    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [hash]);
}
