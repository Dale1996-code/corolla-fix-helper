// A stand-in for the endpoints the Symptoms page calls, for tests of the page.
// It applies the filters, ordering, and paging a real request carries, over a
// synthetic in-memory set of symptoms, documents, and procedures, so a test can
// assert what the page does with one page rather than with the whole list. It is
// NOT evidence the server filters correctly -- `server/test/
// symptomListPagination.test.js` owns that; this only has to be faithful enough
// that the page's side of the contract is exercised honestly.

function jsonResponse(payload, { ok = true, status = ok ? 200 : 500 } = {}) {
  return Promise.resolve({ ok, status, json: async () => payload });
}

function updatedTime(symptom) {
  const time = new Date(symptom.updatedAt || 0).getTime();
  return Number.isNaN(time) ? 0 : time;
}

// Every write is stamped one second after the newest stamp in the set, so the
// written symptom re-sorts to the top of "Newest" as a real write does.
function nextWriteStamp(symptoms) {
  return new Date(Math.max(0, ...symptoms.map(updatedTime)) + 1000).toISOString();
}

function matchesStatus(status, filter) {
  if (!filter) return true;
  if (filter === "active") return status === "open" || status === "monitoring";
  return status === filter;
}

function applyListRequest(state, params) {
  const query = (params.get("q") || "").trim().toLowerCase();
  const status = params.get("status");
  const system = params.get("system");
  const confidence = params.get("confidence");
  const sort = params.get("sort") || "newest";

  // The base order is the server's: latest update first, then highest id.
  const base = [...state.symptoms].sort(
    (first, second) => updatedTime(second) - updatedTime(first) || second.id - first.id
  );
  const matching = base.filter(
    (symptom) =>
      matchesStatus(symptom.status, status) &&
      (!system || symptom.system === system) &&
      (!confidence || symptom.confidence === confidence) &&
      (!query ||
        [symptom.title, symptom.system, symptom.suspectedCauses, symptom.notes].some((value) =>
          (value || "").toLowerCase().includes(query)
        ))
  );
  const ordered = [...matching].sort((first, second) => {
    if (sort === "title") return first.title.localeCompare(second.title);
    if (sort === "oldest") return updatedTime(first) - updatedTime(second);
    return updatedTime(second) - updatedTime(first);
  });

  const limit = Number(params.get("limit")) || 25;
  const offset = Number(params.get("offset")) || 0;
  const statusCounts = { open: 0, monitoring: 0, resolved: 0 };

  for (const symptom of state.symptoms) {
    if (symptom.status === "monitoring") statusCounts.monitoring += 1;
    else if (symptom.status === "resolved") statusCounts.resolved += 1;
    else statusCounts.open += 1;
  }

  return {
    symptoms: ordered.slice(offset, offset + limit),
    total: state.symptoms.length,
    matched: matching.length,
    statusCounts,
    limit,
    offset,
  };
}

function applySearchRequest(records, params, fields) {
  const query = (params.get("q") || "").trim().toLowerCase();
  const matching = records.filter(
    (record) =>
      !query || fields.some((field) => (record[field] || "").toLowerCase().includes(query))
  );
  const limit = Number(params.get("limit")) || 25;
  const offset = Number(params.get("offset")) || 0;
  const results = matching.slice(offset, offset + limit);

  return {
    results,
    total: matching.length,
    limit,
    offset,
    hasMore: offset + results.length < matching.length,
  };
}

function linkedDocumentsFor(state, ids) {
  return state.documents
    .filter((document) => ids.includes(document.id))
    .map(({ id, title, system, documentType }) => ({ id, title, system, documentType }));
}

function linkedProceduresFor(state, ids) {
  return state.procedures
    .filter((procedure) => ids.includes(procedure.id))
    .map(({ id, title, system, difficulty }) => ({ id, title, system, difficulty }));
}

/**
 * @param {{ symptoms?: object[], documents?: object[], procedures?: object[] }} library
 * @param {object} [hooks]
 * @param {(url: string, init: object, state: object) => (Promise<object>|undefined)} [hooks.extra]
 *   called first for every request, so a test can override, delay, or fail any
 *   of them; return a response to handle it, or undefined to fall through.
 *   `state.route(url, init)` is the stand-in's own answer, for a delayed request
 */
export function createSymptomsApi(
  { symptoms = [], documents = [], procedures = [] } = {},
  { extra } = {}
) {
  const state = {
    symptoms: symptoms.map((symptom) => ({ ...symptom })),
    documents,
    procedures,
    // Every paged list request the page made, parsed, in order.
    listRequests: [],
    // Every by-id lookup, as the path requested.
    lookups: [],
    // Every picker search, as `path?query`.
    pickerRequests: [],
    // Every whole-collection GET (the requests this change removed).
    fullListRequests: [],
    writes: [],
    nextId: Math.max(0, ...symptoms.map((symptom) => symptom.id)) + 1,
  };

  // The stand-in's own answer, skipping `extra`: a test that delays or fails a
  // request can still hand it on to here once it has done so.
  state.route = (url, init = {}) => {
    const [path, query = ""] = String(url).split("?");
    const method = init.method || "GET";
    const params = new URLSearchParams(query);

    if (method === "GET" && path === "/api/symptoms") {
      if (!params.has("limit")) {
        state.fullListRequests.push(url);
        return jsonResponse({ symptoms: state.symptoms, total: state.symptoms.length });
      }

      state.listRequests.push(params);
      return jsonResponse(applyListRequest(state, params));
    }

    if (method === "GET" && (path === "/api/documents" || path === "/api/procedures")) {
      state.fullListRequests.push(url);
      return jsonResponse({ documents: state.documents, procedures: state.procedures });
    }

    if (method === "GET" && path === "/api/symptoms/filter-options") {
      const systems = Array.from(
        new Set(state.symptoms.map((symptom) => symptom.system).filter(Boolean))
      ).sort((first, second) => first.localeCompare(second));
      return jsonResponse({ systems });
    }

    if (method === "POST" && path === "/api/symptoms") {
      const body = JSON.parse(init.body || "{}");
      const linkedDocumentIds = body.linkedDocumentIds || [];
      const stamp = nextWriteStamp(state.symptoms);
      const created = {
        id: state.nextId,
        title: body.title,
        description: body.description || "",
        system: body.system || "",
        suspectedCauses: body.suspectedCauses || "",
        confidence: body.confidence || "medium",
        status: body.status || "open",
        notes: body.notes || "",
        createdAt: stamp,
        updatedAt: stamp,
        linkedDocumentIds,
        linkedDocuments: linkedDocumentsFor(state, linkedDocumentIds),
        linkedProcedureIds: [],
        linkedProcedures: [],
      };

      state.nextId += 1;
      state.symptoms.push(created);
      state.writes.push({ method, path, body });
      return jsonResponse({ symptom: created }, { status: 201 });
    }

    const procedureLinks = path.match(/^\/api\/symptoms\/(\d+)\/procedures$/);

    if (method === "PUT" && procedureLinks) {
      const symptom = state.symptoms.find((item) => item.id === Number(procedureLinks[1]));
      const body = JSON.parse(init.body || "{}");

      if (!symptom) {
        return jsonResponse({ error: "Symptom not found." }, { ok: false, status: 404 });
      }

      symptom.linkedProcedureIds = body.procedureIds || [];
      symptom.linkedProcedures = linkedProceduresFor(state, symptom.linkedProcedureIds);
      state.writes.push({ method, path, body });
      return jsonResponse({ symptom: { ...symptom } });
    }

    const byId = path.match(/^\/api\/symptoms\/(\d+)$/);

    if (byId) {
      const id = Number(byId[1]);
      const index = state.symptoms.findIndex((symptom) => symptom.id === id);

      if (method === "GET") {
        state.lookups.push(path);
      }

      if (index === -1) {
        return jsonResponse({ error: "Symptom not found." }, { ok: false, status: 404 });
      }

      if (method === "GET") {
        return jsonResponse({ symptom: state.symptoms[index] });
      }

      if (method === "PUT") {
        const body = JSON.parse(init.body || "{}");
        const merged = {
          ...state.symptoms[index],
          ...body,
          updatedAt: nextWriteStamp(state.symptoms),
        };

        if (body.linkedDocumentIds) {
          merged.linkedDocuments = linkedDocumentsFor(state, body.linkedDocumentIds);
        }

        state.symptoms[index] = merged;
        state.writes.push({ method, path, body });
        return jsonResponse({ symptom: merged });
      }

      if (method === "DELETE") {
        state.symptoms.splice(index, 1);
        state.writes.push({ method, path });
        return jsonResponse({ message: "Symptom deleted." });
      }
    }

    if (method === "GET" && path === "/api/search/documents") {
      state.pickerRequests.push(String(url));
      return jsonResponse(
        applySearchRequest(state.documents, params, ["title", "system", "documentType"])
      );
    }

    if (method === "GET" && path === "/api/search/procedures") {
      state.pickerRequests.push(String(url));
      return jsonResponse(applySearchRequest(state.procedures, params, ["title", "system"]));
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
 * A synthetic symptom with every field the page reads.
 *
 * @param {number} id
 * @param {object} [overrides]
 */
export function buildSymptom(id, overrides = {}) {
  const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString();

  return {
    id,
    title: `Symptom ${String(id).padStart(3, "0")}`,
    description: "",
    system: "Engine",
    suspectedCauses: "",
    confidence: "medium",
    status: "open",
    notes: "",
    createdAt: stamp,
    updatedAt: stamp,
    linkedDocumentIds: [],
    linkedDocuments: [],
    linkedProcedureIds: [],
    linkedProcedures: [],
    ...overrides,
  };
}

export { jsonResponse };
