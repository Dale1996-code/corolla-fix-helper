// A stand-in for the Documents endpoints, for tests of the page. It applies the
// filters, ordering, and paging a real request carries, over a synthetic
// in-memory library, so a test can assert what the page does with a page rather
// than with the whole list. It is NOT evidence the server filters correctly --
// `server/test/documentListPagination.test.js` owns that; this only has to be
// faithful enough that the page's side of the contract is exercised honestly.

function jsonResponse(payload, { ok = true, status = ok ? 200 : 500 } = {}) {
  return Promise.resolve({ ok, status, json: async () => payload });
}

function touchedAt(document) {
  const time = new Date(document.updatedAt || document.createdAt || 0).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function applyListRequest(library, params) {
  const system = params.get("system");
  const documentType = params.get("documentType");
  const favorite = params.get("favorite");
  const bookmarked = params.get("bookmarked");
  const tag = params.get("tag");

  const matching = library.filter((document) => {
    if (system && document.system !== system) return false;
    if (documentType && document.documentType !== documentType) return false;
    if (favorite === "true" && !document.isFavorite) return false;
    if (favorite === "false" && document.isFavorite) return false;
    if (bookmarked === "true" && !document.isBookmarked) return false;
    if (bookmarked === "false" && document.isBookmarked) return false;
    if (tag && !(document.tags || []).some((name) => name.toLowerCase() === tag.toLowerCase())) {
      return false;
    }
    return true;
  });

  const sort = params.get("sort");
  const ordered = [...matching].sort((first, second) => {
    if (sort === "title_asc") {
      return first.title.localeCompare(second.title, undefined, { sensitivity: "base" });
    }
    if (sort === "oldest") {
      return touchedAt(first) - touchedAt(second);
    }
    return touchedAt(second) - touchedAt(first);
  });

  const limit = Number(params.get("limit")) || 50;
  const offset = Number(params.get("offset")) || 0;

  return {
    documents: ordered.slice(offset, offset + limit),
    total: library.length,
    matched: matching.length,
    limit,
    offset,
  };
}

/**
 * @param {object[]} initialLibrary the synthetic library
 * @param {object} [hooks]
 * @param {(url: string, init: object) => (Promise<object>|undefined)} [hooks.extra]
 *   called first for requests this stand-in does not own (settings, PUT, ...);
 *   return a response to handle it, or undefined to fall through
 * @returns {{ fetch: Function, library: object[], listRequests: URLSearchParams[], lookups: string[] }}
 */
export function createDocumentsApi(initialLibrary, { extra } = {}) {
  const state = {
    library: [...initialLibrary],
    // Every list request the page made, parsed, in order.
    listRequests: [],
    // Every by-id lookup, as the path requested.
    lookups: [],
    filterOptionRequests: 0,
  };

  state.fetch = (url, init = {}) => {
    const handled = extra?.(String(url), init, state);

    if (handled !== undefined) {
      return handled;
    }

    const [path, query = ""] = String(url).split("?");
    const method = init.method || "GET";

    if (method === "GET" && path === "/api/documents") {
      const params = new URLSearchParams(query);
      state.listRequests.push(params);
      return jsonResponse(applyListRequest(state.library, params));
    }

    if (method === "GET" && path === "/api/documents/filter-options") {
      state.filterOptionRequests += 1;
      const unique = (values) => Array.from(new Set(values.filter(Boolean))).sort();
      return jsonResponse({
        systems: unique(state.library.map((document) => document.system)),
        documentTypes: unique(state.library.map((document) => document.documentType)),
        tags: unique(state.library.flatMap((document) => document.tags || [])),
      });
    }

    const byId = path.match(/^\/api\/documents\/(\d+)$/);

    if (method === "GET" && byId) {
      state.lookups.push(path);
      const found = state.library.find((document) => document.id === Number(byId[1]));

      return found
        ? jsonResponse({ document: found })
        : jsonResponse({ error: "Document not found." }, { ok: false, status: 404 });
    }

    if (path === "/api/settings") {
      return jsonResponse({ documentDefaults: { commonSystems: [], documentTypes: [] } });
    }

    throw new Error(`Unexpected fetch call: ${method} ${url}`);
  };

  return state;
}

export { jsonResponse };
