// A stand-in for the endpoints the Procedures page calls, for tests of the page.
// It applies the filters, ordering, and paging a real request carries, over a
// synthetic in-memory set of procedures, documents, and symptoms, so a test can
// assert what the page does with one page rather than with the whole list. It is
// NOT evidence the server filters correctly -- `server/test/
// procedureNoteListPagination.test.js` owns that; this only has to be faithful
// enough that the page's side of the contract is exercised honestly.
import { applySearchRequest, jsonResponse } from "./symptomsApiMock";

function updatedTime(procedure) {
  const time = new Date(procedure.updatedAt || procedure.createdAt || 0).getTime();
  return Number.isNaN(time) ? 0 : time;
}

// Every write is stamped one second after the newest stamp in the set, so the
// written procedure re-sorts to the top of "Newest" as a real write does.
function nextWriteStamp(procedures) {
  return new Date(Math.max(0, ...procedures.map(updatedTime)) + 1000).toISOString();
}

function applyListRequest(state, params) {
  const query = (params.get("q") || "").trim().toLowerCase();
  const system = params.get("system");
  const difficulty = params.get("difficulty");
  const confidence = params.get("confidence");
  const sort = params.get("sort") || "newest";

  // The base order is the server's: latest update first, then highest id.
  const base = [...state.procedures].sort(
    (first, second) => updatedTime(second) - updatedTime(first) || second.id - first.id
  );
  const matching = base.filter(
    (procedure) =>
      (!system || procedure.system === system) &&
      (!difficulty || procedure.difficulty === difficulty) &&
      (!confidence || procedure.confidence === confidence) &&
      (!query ||
        ["title", "system", "toolsNeeded", "partsNeeded", "notes", "steps"].some((field) =>
          (procedure[field] || "").toLowerCase().includes(query)
        ))
  );
  const ordered = [...matching].sort((first, second) => {
    if (sort === "title") return first.title.localeCompare(second.title);
    if (sort === "oldest") return updatedTime(first) - updatedTime(second);
    return updatedTime(second) - updatedTime(first);
  });
  const limit = Number(params.get("limit")) || 25;
  const offset = Number(params.get("offset")) || 0;

  return {
    procedures: ordered.slice(offset, offset + limit),
    matched: ordered.length,
    total: state.procedures.length,
    limit,
    offset,
  };
}

function withLinks(state, procedure) {
  const linkedDocumentIds = procedure.linkedDocumentIds || [];
  const linkedSymptomIds = procedure.linkedSymptomIds || [];

  return {
    ...procedure,
    linkedDocumentIds,
    linkedDocuments: state.documents
      .filter((document) => linkedDocumentIds.includes(document.id))
      .map(({ id, title, system, documentType }) => ({ id, title, system, documentType })),
    linkedSymptomIds,
    linkedSymptoms: state.symptoms
      .filter((symptom) => linkedSymptomIds.includes(symptom.id))
      .map(({ id, title, system, status }) => ({ id, title, system, status })),
  };
}

/**
 * @param {{ procedures?: object[], documents?: object[], symptoms?: object[] }} library
 * @param {object} [hooks]
 * @param {(url: string, init: object, state: object) => (Promise<object>|undefined)} [hooks.extra]
 *   called first for every request, so a test can override, delay, or fail any
 *   of them; return a response to handle it, or undefined to fall through.
 *   `state.route(url, init)` is the stand-in's own answer, for a delayed request
 */
export function createProceduresApi(
  { procedures = [], documents = [], symptoms = [] } = {},
  { extra } = {}
) {
  const state = {
    procedures: procedures.map((procedure) => withLinks({ documents, symptoms }, procedure)),
    documents,
    symptoms,
    // Every paged list request the page made, parsed, in order.
    listRequests: [],
    // Every by-id lookup, as the path requested.
    lookups: [],
    // Every picker search, as `path?query`.
    pickerRequests: [],
    // Every whole-collection GET (the requests N7 removed).
    fullListRequests: [],
    writes: [],
    nextId: Math.max(0, ...procedures.map((procedure) => procedure.id)) + 1,
  };

  state.route = (url, init = {}) => {
    const [path, query = ""] = String(url).split("?");
    const method = init.method || "GET";
    const params = new URLSearchParams(query);
    const body = init.body ? JSON.parse(init.body) : null;

    if (method === "GET" && path === "/api/procedures") {
      if (!params.has("limit")) {
        state.fullListRequests.push(url);
        return jsonResponse({ procedures: state.procedures, total: state.procedures.length });
      }

      state.listRequests.push(params);
      return jsonResponse(applyListRequest(state, params));
    }

    if (method === "GET" && ["/api/documents", "/api/symptoms"].includes(path)) {
      state.fullListRequests.push(url);
      return jsonResponse({ documents: state.documents, symptoms: state.symptoms });
    }

    if (method === "GET" && path === "/api/procedures/filter-options") {
      const systems = Array.from(
        new Set(state.procedures.map((procedure) => procedure.system).filter(Boolean))
      ).sort((first, second) => first.localeCompare(second));
      return jsonResponse({ systems });
    }

    if (method === "POST" && path === "/api/procedures") {
      const procedure = withLinks(state, {
        createdAt: nextWriteStamp(state.procedures),
        ...body,
        id: state.nextId,
        updatedAt: nextWriteStamp(state.procedures),
      });
      state.nextId += 1;
      state.procedures.push(procedure);
      state.writes.push({ method, path, body });
      return jsonResponse({ procedure });
    }

    const byId = path.match(/^\/api\/procedures\/(\d+)(\/symptoms)?$/);

    if (byId) {
      const id = Number(byId[1]);
      const index = state.procedures.findIndex((procedure) => procedure.id === id);

      if (method === "GET" && !byId[2]) {
        state.lookups.push(path);
        return index < 0
          ? jsonResponse({ error: "Procedure not found." }, { ok: false, status: 404 })
          : jsonResponse({ procedure: state.procedures[index] });
      }

      if (index < 0) {
        return jsonResponse({ error: "Procedure not found." }, { ok: false, status: 404 });
      }

      if (method === "PUT" && byId[2]) {
        const merged = withLinks(state, {
          ...state.procedures[index],
          linkedSymptomIds: body.symptomIds,
          updatedAt: nextWriteStamp(state.procedures),
        });
        state.procedures[index] = merged;
        state.writes.push({ method, path, body });
        return jsonResponse({ procedure: merged });
      }

      if (method === "PUT") {
        const merged = withLinks(state, {
          ...state.procedures[index],
          ...body,
          updatedAt: nextWriteStamp(state.procedures),
        });
        state.procedures[index] = merged;
        state.writes.push({ method, path, body });
        return jsonResponse({ procedure: merged });
      }

      if (method === "DELETE") {
        state.procedures.splice(index, 1);
        state.writes.push({ method, path });
        return jsonResponse({ message: "Procedure deleted." });
      }
    }

    if (method === "GET" && path === "/api/search/documents") {
      state.pickerRequests.push(String(url));
      return jsonResponse(
        applySearchRequest(state.documents, params, ["title", "system", "documentType"])
      );
    }

    if (method === "GET" && path === "/api/search/symptoms") {
      state.pickerRequests.push(String(url));
      return jsonResponse(applySearchRequest(state.symptoms, params, ["title", "system"]));
    }

    if (path === "/api/settings") {
      return jsonResponse({ documentDefaults: { commonSystems: [], documentTypes: [] } });
    }

    if (path.startsWith("/api/attachments")) {
      return jsonResponse({ attachments: [], total: 0 });
    }

    throw new Error(`Unexpected fetch call: ${method} ${url}`);
  };

  state.fetch = (url, init = {}) => {
    const handled = extra?.(String(url), init, state);
    return handled !== undefined ? handled : state.route(url, init);
  };

  return state;
}

/**
 * A synthetic procedure with every field the page reads.
 *
 * @param {number} id
 * @param {object} [overrides]
 */
export function buildProcedure(id, overrides = {}) {
  const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString();

  return {
    id,
    title: `Procedure ${String(id).padStart(3, "0")}`,
    system: "Brakes",
    difficulty: "beginner",
    toolsNeeded: "",
    partsNeeded: "",
    safetyNotes: "",
    steps: "",
    notes: "",
    confidence: "medium",
    createdAt: stamp,
    updatedAt: stamp,
    linkedDocumentIds: [],
    linkedSymptomIds: [],
    ...overrides,
  };
}
