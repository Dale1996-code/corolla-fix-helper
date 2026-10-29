// A stand-in for the endpoints the Notes page calls, for tests of the page. It
// applies the filters, ordering, and paging a real request carries, over a
// synthetic in-memory set of notes and the records they can link to, so a test
// can assert what the page does with one page rather than with the whole list.
// It is NOT evidence the server filters correctly -- `server/test/
// procedureNoteListPagination.test.js` owns that.
import { applySearchRequest, jsonResponse } from "./symptomsApiMock";

function updatedTime(note) {
  const time = new Date(note.updatedAt || note.createdAt || 0).getTime();
  return Number.isNaN(time) ? 0 : time;
}

// Every write is stamped one second after the newest stamp in the set, so the
// written note re-sorts to the top of "Newest first" as a real write does.
function nextWriteStamp(notes) {
  return new Date(Math.max(0, ...notes.map(updatedTime)) + 1000).toISOString();
}

function applyListRequest(state, params) {
  const noteType = params.get("noteType");
  const relatedEntityType = params.get("relatedEntityType");
  const sort = params.get("sort") || "newest";

  // The base order is the server's: latest update first, then highest id.
  const base = [...state.notes].sort(
    (first, second) => updatedTime(second) - updatedTime(first) || second.id - first.id
  );
  const matching = base.filter(
    (note) =>
      (!noteType || note.noteType === noteType) &&
      (!relatedEntityType || (note.relatedEntityType || "none") === relatedEntityType)
  );
  const ordered = [...matching].sort((first, second) =>
    sort === "oldest" ? updatedTime(first) - updatedTime(second) : updatedTime(second) - updatedTime(first)
  );
  const limit = Number(params.get("limit")) || 25;
  const offset = Number(params.get("offset")) || 0;

  return {
    notes: ordered.slice(offset, offset + limit),
    matched: ordered.length,
    total: state.notes.length,
    limit,
    offset,
  };
}

// A note as the server sends it: the linked record is the live row's summary, or
// null once that record is gone.
function withLinked(state, note) {
  const type = note.relatedEntityType || "none";
  const id = note.relatedEntityId ?? null;
  const find = (records) => records.find((record) => record.id === id) || null;

  return {
    ...note,
    relatedEntityType: type,
    relatedEntityId: id,
    linkedDocument: type === "document" ? find(state.documents) : null,
    linkedSymptom: type === "symptom" ? find(state.symptoms) : null,
    linkedProcedure: type === "procedure" ? find(state.procedures) : null,
  };
}

/**
 * @param {{ notes?: object[], documents?: object[], symptoms?: object[], procedures?: object[] }} library
 * @param {object} [hooks]
 * @param {(url: string, init: object, state: object) => (Promise<object>|undefined)} [hooks.extra]
 *   called first for every request, so a test can override, delay, or fail any
 *   of them; return a response to handle it, or undefined to fall through.
 */
export function createNotesApi(
  { notes = [], documents = [], symptoms = [], procedures = [] } = {},
  { extra } = {}
) {
  const state = {
    documents,
    symptoms,
    procedures,
    notes: [],
    listRequests: [],
    lookups: [],
    pickerRequests: [],
    // Every whole-collection GET (the requests N7 removed).
    fullListRequests: [],
    writes: [],
    nextId: Math.max(0, ...notes.map((note) => note.id)) + 1,
  };
  state.notes = notes.map((note) => withLinked(state, note));

  state.route = (url, init = {}) => {
    const [path, query = ""] = String(url).split("?");
    const method = init.method || "GET";
    const params = new URLSearchParams(query);
    const body = init.body ? JSON.parse(init.body) : null;

    if (method === "GET" && path === "/api/notes") {
      if (!params.has("limit")) {
        state.fullListRequests.push(url);
        return jsonResponse({ notes: state.notes, total: state.notes.length });
      }

      state.listRequests.push(params);
      return jsonResponse(applyListRequest(state, params));
    }

    if (method === "GET" && ["/api/documents", "/api/symptoms", "/api/procedures"].includes(path)) {
      state.fullListRequests.push(url);
      return jsonResponse({
        documents: state.documents,
        symptoms: state.symptoms,
        procedures: state.procedures,
      });
    }

    if (method === "GET" && path === "/api/notes/filter-options") {
      const noteTypes = Array.from(new Set(state.notes.map((note) => note.noteType).filter(Boolean))).sort();
      return jsonResponse({ noteTypes });
    }

    if (method === "POST" && path === "/api/notes") {
      const note = withLinked(state, {
        createdAt: nextWriteStamp(state.notes),
        ...body,
        id: state.nextId,
        updatedAt: nextWriteStamp(state.notes),
      });
      state.nextId += 1;
      state.notes.push(note);
      state.writes.push({ method, path, body });
      return jsonResponse({ note });
    }

    const byId = path.match(/^\/api\/notes\/(\d+)$/);

    if (byId) {
      const id = Number(byId[1]);
      const index = state.notes.findIndex((note) => note.id === id);

      if (method === "GET") {
        state.lookups.push(path);
        return index < 0
          ? jsonResponse({ error: "Note not found." }, { ok: false, status: 404 })
          : jsonResponse({ note: state.notes[index] });
      }

      if (index < 0) {
        return jsonResponse({ error: "Note not found." }, { ok: false, status: 404 });
      }

      if (method === "PUT") {
        const merged = withLinked(state, {
          ...state.notes[index],
          ...body,
          updatedAt: nextWriteStamp(state.notes),
        });
        state.notes[index] = merged;
        state.writes.push({ method, path, body });
        return jsonResponse({ note: merged });
      }

      if (method === "DELETE") {
        state.notes.splice(index, 1);
        state.writes.push({ method, path });
        return jsonResponse({ message: "Note deleted." });
      }
    }

    const search = {
      "/api/search/documents": [state.documents, ["title", "system", "documentType"]],
      "/api/search/symptoms": [state.symptoms, ["title", "system"]],
      "/api/search/procedures": [state.procedures, ["title", "system"]],
    }[path];

    if (method === "GET" && search) {
      state.pickerRequests.push(String(url));
      return jsonResponse(applySearchRequest(search[0], params, search[1]));
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
 * A synthetic note. A link is set with `relatedEntityType` and `relatedEntityId`;
 * the stand-in fills in the linked record from its library.
 *
 * @param {number} id
 * @param {object} [overrides]
 */
export function buildNote(id, overrides = {}) {
  const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString();

  return {
    id,
    title: `Note ${String(id).padStart(3, "0")}`,
    content: "",
    noteType: "general",
    relatedEntityType: "none",
    relatedEntityId: null,
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  };
}
