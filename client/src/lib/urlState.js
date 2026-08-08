import { useEffect, useRef, useState } from "react";

// The query string is the canonical home for list view state -- which filters
// are on, which page is showing, and which record the detail panel describes.
// Holding that state in component state instead meant the browser had no record
// of it: change a filter, page forward, pick a record, navigate away, press Back
// and every one of them was gone, because the URL had never changed.
//
// Three rules run through every helper here:
//
// 1. A parameter sitting at its default value is omitted. `/documents` and
//    `/documents?sort=newest&page=1` describe the same view, so only the short
//    form is ever produced -- otherwise every list would carry a banner of
//    parameters that say nothing.
// 2. Reading is total. Any string at all can arrive in a query string --
//    hand-typed, stale, bookmarked from an older release -- so every reader
//    falls back to its default instead of throwing or handing a lookup a value
//    it cannot use.
// 3. Writing is additive. Every write carries through parameters it does not
//    recognise, so one page's controls can never drop another feature's
//    parameter (a deep link's `#`-anchor companion, a future filter) just
//    because they did not know about it.

export const DEFAULT_PAGE = 1;

/**
 * A query-string value constrained to a known set of options.
 *
 * @param {URLSearchParams} searchParams
 * @param {string} key
 * @param {string[]} allowedValues
 * @param {string} fallback
 * @returns {string}
 */
export function readEnumParam(searchParams, key, allowedValues, fallback) {
  const value = searchParams.get(key);

  return allowedValues.includes(value) ? value : fallback;
}

/**
 * A free-text query-string value -- a keyword box, or a filter whose options
 * come from the owner's own data (a system name, a tag) and so cannot be
 * enumerated here. A value that matches nothing simply filters the list to
 * empty, which is an honest answer rather than an error.
 *
 * @param {URLSearchParams} searchParams
 * @param {string} key
 * @param {string} [fallback]
 * @returns {string}
 */
export function readTextParam(searchParams, key, fallback = "") {
  const value = searchParams.get(key);

  return typeof value === "string" && value !== "" ? value : fallback;
}

/**
 * A record id. Anything that is not a positive integer -- "abc", "0", "-4",
 * "2.5", "1e3", "", a repeated parameter's first value -- reads as "no
 * selection" rather than being passed on to a lookup. `Number()` alone is too
 * permissive here: it accepts " 12 ", "0x0c", and "1e3", none of which a link
 * this app generated would ever contain.
 *
 * @param {URLSearchParams} searchParams
 * @param {string} key
 * @returns {number|null}
 */
export function readIdParam(searchParams, key) {
  const rawValue = searchParams.get(key);

  if (!rawValue || !/^[0-9]+$/.test(rawValue)) {
    return null;
  }

  const value = Number(rawValue);

  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * A 1-based page number. Missing, malformed, and below-range values all read as
 * page 1; the caller clamps the top end once it knows how many pages there
 * actually are, since that depends on data this module cannot see.
 *
 * @param {URLSearchParams} searchParams
 * @param {string} [key]
 * @returns {number}
 */
export function readPageParam(searchParams, key = "page") {
  const rawValue = searchParams.get(key);

  if (!rawValue || !/^[0-9]+$/.test(rawValue)) {
    return DEFAULT_PAGE;
  }

  const value = Number(rawValue);

  return Number.isSafeInteger(value) && value >= DEFAULT_PAGE ? value : DEFAULT_PAGE;
}

/**
 * The page number a URL should carry: omitted on page 1, present otherwise.
 *
 * @param {number} page
 * @returns {string|null}
 */
export function pageParamValue(page) {
  return page > DEFAULT_PAGE ? String(page) : null;
}

/**
 * A new URLSearchParams with `updates` applied on top of `searchParams`.
 *
 * A key mapped to null/undefined/"" is removed, so a caller expresses "this is
 * back at its default" as `{ sort: null }` and never has to remember a separate
 * delete. Keys absent from `updates` are carried through untouched (rule 3).
 *
 * @param {URLSearchParams} searchParams
 * @param {Record<string, string|number|null|undefined>} updates
 * @returns {URLSearchParams}
 */
export function applyParamUpdates(searchParams, updates) {
  const nextParams = new URLSearchParams(searchParams);

  Object.entries(updates).forEach(([key, value]) => {
    if (value === null || value === undefined || value === "") {
      nextParams.delete(key);
      return;
    }

    nextParams.set(key, String(value));
  });

  return nextParams;
}

/**
 * Read a whole group of filters in one call.
 *
 * `spec` maps each parameter name to `{ default, options? }` -- `options` for a
 * closed set (a status dropdown), omitted for free text (a keyword box, or a
 * dropdown whose choices are built from the owner's data).
 *
 * @param {URLSearchParams} searchParams
 * @param {Record<string, { default: string, options?: string[] }>} spec
 * @returns {Record<string, string>}
 */
export function readFilterValues(searchParams, spec) {
  const values = {};

  Object.entries(spec).forEach(([key, definition]) => {
    values[key] = definition.options
      ? readEnumParam(searchParams, key, definition.options, definition.default)
      : readTextParam(searchParams, key, definition.default);
  });

  return values;
}

/**
 * The updates that write a filter group back to the URL, dropping every value
 * still sitting at its default.
 *
 * @param {Record<string, string>} values
 * @param {Record<string, { default: string, options?: string[] }>} spec
 * @returns {Record<string, string|null>}
 */
export function filterValueUpdates(values, spec) {
  const updates = {};

  Object.entries(values).forEach(([key, value]) => {
    updates[key] = value === spec[key]?.default ? null : value;
  });

  return updates;
}

/**
 * Every parameter name a filter spec owns -- used to clear a whole group
 * without touching anything else in the query string.
 *
 * @param {Record<string, unknown>} spec
 * @returns {Record<string, null>}
 */
export function clearFilterUpdates(spec) {
  const updates = {};

  Object.keys(spec).forEach((key) => {
    updates[key] = null;
  });

  return updates;
}

/**
 * Which record a list/detail page should describe, given what the URL asks for.
 *
 * `records` is everything loaded; `visibleRecords` is what the current filters
 * leave on screen. The precedence is the behaviour these pages already had,
 * written out declaratively instead of assembled by a load handler and a
 * follow-up effect:
 *
 *   1. the record the URL names, if the filters still show it;
 *   2. otherwise the first loaded record, if the filters still show it;
 *   3. otherwise the first record that is visible at all.
 *
 * Step 2 is why an unfiltered list opens on the first record the server sent
 * rather than on whatever the chosen sort happens to float to the top -- worth
 * keeping deliberately, since it is what the pages did before the URL held the
 * selection, and changing it is a separate decision from fixing Back.
 *
 * @template {{ id: number }} Record
 * @param {number|null} requestedId
 * @param {Record[]} records
 * @param {Record[]} visibleRecords
 * @returns {Record|null}
 */
export function resolveSelectedRecord(requestedId, records, visibleRecords) {
  const requestedRecord = requestedId
    ? visibleRecords.find((record) => record.id === requestedId)
    : null;

  if (requestedRecord) {
    return requestedRecord;
  }

  const firstLoadedId = records[0]?.id;
  const firstLoadedRecord = firstLoadedId
    ? visibleRecords.find((record) => record.id === firstLoadedId)
    : null;

  return firstLoadedRecord || visibleRecords[0] || null;
}

/**
 * A text filter that types locally and lands in the URL a beat later.
 *
 * The list keeps filtering from the draft on every keystroke, exactly as it did
 * before the URL held this state, while the query string is updated with
 * `replace` after a short pause. Typing "brake" is one view the owner meant to
 * reach, not five, and it should not cost five Back presses to leave. An
 * external URL change -- Back, Forward, a pasted link -- resets the draft, so
 * the box always shows what the list is actually filtered by.
 *
 * @param {string} key
 * @param {{
 *   searchParams: URLSearchParams,
 *   setSearchParams: (updater: (current: URLSearchParams) => URLSearchParams, options?: object) => void,
 *   delayMs?: number,
 * }} options
 * @returns {[string, (value: string) => void]}
 */
export function useDraftTextParam(key, { searchParams, setSearchParams, delayMs = 300 }) {
  const committedValue = readTextParam(searchParams, key);
  const [draftValue, setDraftValue] = useState(committedValue);

  // react-router rebuilds setSearchParams whenever the URL changes. Holding it
  // in a ref keeps that identity churn out of the timer effect below, which
  // would otherwise restart the countdown on every unrelated URL change.
  const setSearchParamsRef = useRef(setSearchParams);
  setSearchParamsRef.current = setSearchParams;

  // URL -> draft: Back/Forward and deep links win over whatever was typed.
  useEffect(() => {
    setDraftValue(committedValue);
  }, [committedValue]);

  // draft -> URL, once typing pauses. Converges: the write makes committedValue
  // equal draftValue, after which this effect returns before scheduling again.
  useEffect(() => {
    if (draftValue === committedValue) {
      return undefined;
    }

    const timer = setTimeout(() => {
      setSearchParamsRef.current(
        (currentParams) => applyParamUpdates(currentParams, { [key]: draftValue || null }),
        { replace: true }
      );
    }, delayMs);

    return () => clearTimeout(timer);
  }, [draftValue, committedValue, key, delayMs]);

  return [draftValue, setDraftValue];
}
