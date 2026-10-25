import { useEffect, useRef, useState } from "react";

// A picker asks for this many records at a time; "Show more" asks for the next.
export const RECORD_PICKER_PAGE_SIZE = 25;

/**
 * Bounded, searchable results from one of the paged `/api/search/*` endpoints,
 * for a picker that links records (a symptom's documents or procedures). It
 * replaces downloading the whole library to render one checkbox per record.
 *
 * The box types into `draftQuery`; the request follows once typing pauses, so
 * "brake" is one request rather than five. Only the newest request's answer is
 * ever shown: a slow answer to an older keyword is dropped when it lands.
 *
 * `cache` (a Map, optional) lets several pickers on one page share answers, so
 * opening another symptom does not ask for the same first page again. Failed
 * answers are never cached.
 *
 * @param {string} endpoint e.g. "/api/search/documents"
 * @param {{ cache?: Map<string, object>|null, delayMs?: number }} [options]
 */
export function useRecordSearch(endpoint, { cache = null, delayMs = 300 } = {}) {
  const [draftQuery, setDraftQuery] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [results, setResults] = useState([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  // The keyword the results above answer; null until the first answer lands.
  const [settledQuery, setSettledQuery] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const latestRequest = useRef(0);

  // Draft -> request, once typing pauses. A new keyword starts from its first
  // page; the results on screen stay until that page arrives.
  useEffect(() => {
    const trimmed = draftQuery.trim();

    if (trimmed === query) {
      return undefined;
    }

    const timer = setTimeout(() => {
      setQuery(trimmed);
      setOffset(0);
    }, delayMs);

    return () => clearTimeout(timer);
  }, [draftQuery, query, delayMs]);

  useEffect(() => {
    const requestId = latestRequest.current + 1;
    latestRequest.current = requestId;

    const params = new URLSearchParams({
      limit: String(RECORD_PICKER_PAGE_SIZE),
      offset: String(offset),
    });

    if (query) {
      params.set("q", query);
    }

    const url = `${endpoint}?${params.toString()}`;

    async function load() {
      setLoading(true);

      try {
        let payload = cache?.get(url);

        if (!payload) {
          const response = await fetch(url);
          const body = await response.json();

          if (!response.ok) {
            throw new Error(body.error || "The list could not be loaded.");
          }

          payload = body;
          cache?.set(url, payload);
        }

        if (requestId !== latestRequest.current) {
          return;
        }

        const pageResults = Array.isArray(payload.results) ? payload.results : [];

        setResults((current) => {
          if (offset === 0) {
            return pageResults;
          }

          // A record already shown (the library shifted between pages) is not
          // listed twice.
          const shownIds = new Set(current.map((record) => record.id));
          return [...current, ...pageResults.filter((record) => !shownIds.has(record.id))];
        });
        setTotal(Number.isFinite(payload.total) ? payload.total : pageResults.length);
        setHasMore(Boolean(payload.hasMore));
        setSettledQuery(query);
        setError("");
      } catch (loadError) {
        if (requestId === latestRequest.current) {
          // fetch rejects with a TypeError when the request never reached the
          // server; its own text ("Failed to fetch") means nothing here.
          setError(
            loadError instanceof TypeError
              ? "The server could not be reached."
              : loadError.message || "The list could not be loaded."
          );
        }
      } finally {
        if (requestId === latestRequest.current) {
          setLoading(false);
        }
      }
    }

    load();

    // Unmounting, or asking for something else, makes this answer stale.
    return () => {
      latestRequest.current += 1;
    };
  }, [endpoint, query, offset, attempt, cache]);

  return {
    draftQuery,
    setDraftQuery,
    query,
    settledQuery,
    results,
    total,
    hasMore,
    loading,
    error,
    // Known only once an unfiltered answer says there is nothing at all.
    libraryIsEmpty: settledQuery === "" && total === 0 && !error,
    loadMore() {
      if (hasMore && !loading) {
        setOffset((current) => current + RECORD_PICKER_PAGE_SIZE);
      }
    },
    retry() {
      setAttempt((current) => current + 1);
    },
  };
}
