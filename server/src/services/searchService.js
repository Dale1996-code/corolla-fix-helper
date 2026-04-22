import { db } from "../database.js";

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeForSearch(value) {
  return normalizeText(value).toLowerCase();
}

function getVehicleId() {
  const vehicle = db
    .prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1")
    .get();

  if (!vehicle) {
    throw new Error("No vehicle record exists yet.");
  }

  return vehicle.id;
}

function uniqueSorted(values) {
  return Array.from(
    new Set(values.map((value) => normalizeText(value)).filter(Boolean))
  ).sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
}

function buildSnippet(text, query) {
  const cleanText = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";

  if (!cleanText) {
    return "";
  }

  if (!query) {
    return cleanText.length > 180 ? `${cleanText.slice(0, 177)}...` : cleanText;
  }

  const loweredText = cleanText.toLowerCase();
  const loweredQuery = query.toLowerCase();
  const matchIndex = loweredText.indexOf(loweredQuery);

  if (matchIndex === -1) {
    return cleanText.length > 180 ? `${cleanText.slice(0, 177)}...` : cleanText;
  }

  const snippetRadius = 80;
  const start = Math.max(0, matchIndex - snippetRadius);
  const end = Math.min(cleanText.length, matchIndex + loweredQuery.length + snippetRadius);
  const snippet = cleanText.slice(start, end).trim();
  const prefix = start > 0 ? "..." : "";
  const suffix = end < cleanText.length ? "..." : "";

  return `${prefix}${snippet}${suffix}`;
}

function getSnippetMatch(fields, query) {
  if (!query) {
    const previewField = fields.find((field) => normalizeText(field.value));

    return {
      snippet: previewField ? buildSnippet(previewField.value, "") : "",
      snippetField: previewField ? previewField.label : "",
    };
  }

  const loweredQuery = query.toLowerCase();
  const matchingField = fields.find((field) =>
    normalizeForSearch(field.value).includes(loweredQuery)
  );

  return {
    snippet: matchingField ? buildSnippet(matchingField.value, query) : "",
    snippetField: matchingField ? matchingField.label : "",
  };
}

function calculateRelevance(fields, query) {
  const trimmedQuery = normalizeText(query);

  if (!trimmedQuery) {
    return 0;
  }

  const loweredQuery = trimmedQuery.toLowerCase();
  let score = 0;

  for (const field of fields) {
    const normalizedValue = normalizeForSearch(field.value);

    if (!normalizedValue) {
      continue;
    }

    if (normalizedValue === loweredQuery) {
      score += field.exactWeight ?? field.weight;
      continue;
    }

    if (normalizedValue.includes(loweredQuery)) {
      score += field.weight;
    }
  }

  return score;
}

function matchesQuery(fields, query) {
  const trimmedQuery = normalizeText(query);

  if (!trimmedQuery) {
    return true;
  }

  const loweredQuery = trimmedQuery.toLowerCase();

  return fields.some((field) => normalizeForSearch(field.value).includes(loweredQuery));
}

function compareText(left, right) {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

function compareNewest(left, right) {
  const dateComparison = (right.updatedAt || "").localeCompare(left.updatedAt || "");

  if (dateComparison !== 0) {
    return dateComparison;
  }

  return Number(right.id) - Number(left.id);
}

function sortSearchResults(results, sort, hasQuery) {
  if (sort === "title") {
    return [...results].sort(
      (left, right) => compareText(left.title || "", right.title || "") || compareNewest(left, right)
    );
  }

  if (sort === "newest" || !hasQuery) {
    return [...results].sort(compareNewest);
  }

  return [...results].sort((left, right) => {
    if (right.relevanceScore !== left.relevanceScore) {
      return right.relevanceScore - left.relevanceScore;
    }

    return compareNewest(left, right);
  });
}

function mapSymptomRow(row, linksMap) {
  const linkedDocuments = linksMap.get(row.id) || [];

  return {
    id: row.id,
    title: row.title,
    description: row.description || "",
    system: row.system || "",
    suspectedCauses: row.suspected_causes || "",
    confidence: row.confidence || "medium",
    status: row.status || "open",
    notes: row.notes || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    linkedDocumentIds: linkedDocuments.map((document) => document.id),
    linkedDocuments,
  };
}

function listSymptomsForVehicle(vehicleId) {
  const symptomRows = db
    .prepare(`
      SELECT
        id,
        title,
        description,
        system,
        suspected_causes,
        confidence,
        status,
        notes,
        created_at,
        updated_at
      FROM symptoms
      WHERE vehicle_id = ?
      ORDER BY updated_at DESC, id DESC
    `)
    .all(vehicleId);

  const linkRows = db
    .prepare(`
      SELECT
        symptom_documents.symptom_id,
        documents.id AS document_id,
        documents.title AS document_title,
        documents.system AS document_system,
        documents.document_type AS document_type
      FROM symptom_documents
      JOIN symptoms ON symptoms.id = symptom_documents.symptom_id
      JOIN documents ON documents.id = symptom_documents.document_id
      WHERE symptoms.vehicle_id = ?
      ORDER BY documents.title COLLATE NOCASE ASC
    `)
    .all(vehicleId);

  const linksMap = new Map();

  for (const linkRow of linkRows) {
    if (!linksMap.has(linkRow.symptom_id)) {
      linksMap.set(linkRow.symptom_id, []);
    }

    linksMap.get(linkRow.symptom_id).push({
      id: linkRow.document_id,
      title: linkRow.document_title,
      system: linkRow.document_system || "",
      documentType: linkRow.document_type || "",
    });
  }

  return symptomRows.map((row) => mapSymptomRow(row, linksMap));
}

function mapProcedureRow(row, linksMap) {
  const linkedDocuments = linksMap.get(row.id) || [];

  return {
    id: row.id,
    title: row.title,
    system: row.system || "",
    difficulty: row.difficulty || "intermediate",
    toolsNeeded: row.tools_needed || "",
    partsNeeded: row.parts_needed || "",
    safetyNotes: row.safety_notes || "",
    steps: row.steps || "",
    notes: row.notes || "",
    confidence: row.confidence || "medium",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    linkedDocumentIds: linkedDocuments.map((document) => document.id),
    linkedDocuments,
  };
}

function listProceduresForVehicle(vehicleId) {
  const procedureRows = db
    .prepare(`
      SELECT
        id,
        title,
        system,
        difficulty,
        tools_needed,
        parts_needed,
        safety_notes,
        steps,
        notes,
        confidence,
        created_at,
        updated_at
      FROM procedures
      WHERE vehicle_id = ?
      ORDER BY updated_at DESC, id DESC
    `)
    .all(vehicleId);

  const linkRows = db
    .prepare(`
      SELECT
        procedure_documents.procedure_id,
        documents.id AS document_id,
        documents.title AS document_title,
        documents.system AS document_system,
        documents.document_type AS document_type
      FROM procedure_documents
      JOIN procedures ON procedures.id = procedure_documents.procedure_id
      JOIN documents ON documents.id = procedure_documents.document_id
      WHERE procedures.vehicle_id = ?
      ORDER BY documents.title COLLATE NOCASE ASC
    `)
    .all(vehicleId);

  const linksMap = new Map();

  for (const linkRow of linkRows) {
    if (!linksMap.has(linkRow.procedure_id)) {
      linksMap.set(linkRow.procedure_id, []);
    }

    linksMap.get(linkRow.procedure_id).push({
      id: linkRow.document_id,
      title: linkRow.document_title,
      system: linkRow.document_system || "",
      documentType: linkRow.document_type || "",
    });
  }

  return procedureRows.map((row) => mapProcedureRow(row, linksMap));
}

function mapNoteRow(row) {
  const legacyDocumentId =
    Number.isInteger(row.document_id) && row.document_id > 0 ? row.document_id : null;
  const rawRelatedEntityType = normalizeText(row.related_entity_type).toLowerCase();
  const relatedEntityType = rawRelatedEntityType || (legacyDocumentId ? "document" : "none");
  let relatedEntityId =
    Number.isInteger(row.related_entity_id) && row.related_entity_id > 0
      ? row.related_entity_id
      : null;

  if (relatedEntityType === "document" && !relatedEntityId) {
    relatedEntityId = legacyDocumentId;
  }

  const linkedDocument = row.linked_document_id
    ? {
        id: row.linked_document_id,
        title: row.linked_document_title,
        system: row.linked_document_system || "",
        documentType: row.linked_document_type || "",
      }
    : null;
  const linkedSymptom = row.linked_symptom_id
    ? {
        id: row.linked_symptom_id,
        title: row.linked_symptom_title,
        system: row.linked_symptom_system || "",
        status: row.linked_symptom_status || "open",
      }
    : null;
  const linkedProcedure = row.linked_procedure_id
    ? {
        id: row.linked_procedure_id,
        title: row.linked_procedure_title,
        system: row.linked_procedure_system || "",
        difficulty: row.linked_procedure_difficulty || "intermediate",
      }
    : null;

  return {
    id: row.id,
    title: row.title || "",
    content: row.content || row.body || "",
    noteType: row.note_type || "general",
    relatedEntityType,
    relatedEntityId,
    linkedDocument,
    linkedSymptom,
    linkedProcedure,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listNotesForVehicle(vehicleId) {
  const noteRows = db
    .prepare(`
      SELECT
        notes.id,
        notes.title,
        notes.body,
        notes.content,
        notes.note_type,
        notes.related_entity_type,
        notes.related_entity_id,
        notes.document_id,
        notes.created_at,
        notes.updated_at,
        documents.id AS linked_document_id,
        documents.title AS linked_document_title,
        documents.system AS linked_document_system,
        documents.document_type AS linked_document_type,
        symptoms.id AS linked_symptom_id,
        symptoms.title AS linked_symptom_title,
        symptoms.system AS linked_symptom_system,
        symptoms.status AS linked_symptom_status,
        procedures.id AS linked_procedure_id,
        procedures.title AS linked_procedure_title,
        procedures.system AS linked_procedure_system,
        procedures.difficulty AS linked_procedure_difficulty
      FROM notes
      LEFT JOIN documents ON documents.vehicle_id = notes.vehicle_id
        AND (
          (notes.related_entity_type = 'document' AND notes.related_entity_id = documents.id)
          OR (
            (notes.related_entity_type IS NULL OR TRIM(notes.related_entity_type) = '')
            AND notes.document_id = documents.id
          )
        )
      LEFT JOIN symptoms ON symptoms.vehicle_id = notes.vehicle_id
        AND notes.related_entity_type = 'symptom'
        AND notes.related_entity_id = symptoms.id
      LEFT JOIN procedures ON procedures.vehicle_id = notes.vehicle_id
        AND notes.related_entity_type = 'procedure'
        AND notes.related_entity_id = procedures.id
      WHERE notes.vehicle_id = ?
      ORDER BY notes.updated_at DESC, notes.id DESC
    `)
    .all(vehicleId);

  return noteRows.map((row) => mapNoteRow(row));
}

export function getSymptomFilterOptions() {
  const vehicleId = getVehicleId();
  const symptoms = listSymptomsForVehicle(vehicleId);

  return {
    systems: uniqueSorted(symptoms.map((symptom) => symptom.system)),
    statuses: uniqueSorted(symptoms.map((symptom) => symptom.status)),
  };
}

export function searchSymptoms({ query = "", system = "", status = "", sort = "relevance" }) {
  const vehicleId = getVehicleId();
  const trimmedQuery = normalizeText(query);
  const symptoms = listSymptomsForVehicle(vehicleId);

  const filteredResults = symptoms
    .filter((symptom) => !system || symptom.system === system)
    .filter((symptom) => !status || symptom.status === status)
    .map((symptom) => {
      const fields = [
        { label: "Title", value: symptom.title, weight: 400, exactWeight: 900 },
        { label: "Description", value: symptom.description, weight: 250 },
        { label: "System", value: symptom.system, weight: 120 },
        { label: "Suspected causes", value: symptom.suspectedCauses, weight: 220 },
        { label: "Notes", value: symptom.notes, weight: 140 },
      ];

      return {
        ...symptom,
        linkedDocumentCount: symptom.linkedDocumentIds.length,
        relevanceScore: calculateRelevance(fields, trimmedQuery),
        ...getSnippetMatch(fields, trimmedQuery),
      };
    })
    .filter((symptom) =>
      matchesQuery(
        [
          { value: symptom.title },
          { value: symptom.description },
          { value: symptom.system },
          { value: symptom.suspectedCauses },
          { value: symptom.notes },
        ],
        trimmedQuery
      )
    );

  return sortSearchResults(filteredResults, sort, Boolean(trimmedQuery));
}

export function getProcedureFilterOptions() {
  const vehicleId = getVehicleId();
  const procedures = listProceduresForVehicle(vehicleId);

  return {
    systems: uniqueSorted(procedures.map((procedure) => procedure.system)),
    difficulties: uniqueSorted(procedures.map((procedure) => procedure.difficulty)),
  };
}

export function searchProcedures({
  query = "",
  system = "",
  difficulty = "",
  sort = "relevance",
}) {
  const vehicleId = getVehicleId();
  const trimmedQuery = normalizeText(query);
  const procedures = listProceduresForVehicle(vehicleId);

  const filteredResults = procedures
    .filter((procedure) => !system || procedure.system === system)
    .filter((procedure) => !difficulty || procedure.difficulty === difficulty)
    .map((procedure) => {
      const fields = [
        { label: "Title", value: procedure.title, weight: 400, exactWeight: 900 },
        { label: "System", value: procedure.system, weight: 120 },
        { label: "Tools needed", value: procedure.toolsNeeded, weight: 180 },
        { label: "Parts needed", value: procedure.partsNeeded, weight: 220 },
        { label: "Safety notes", value: procedure.safetyNotes, weight: 180 },
        { label: "Steps", value: procedure.steps, weight: 240 },
        { label: "Notes", value: procedure.notes, weight: 140 },
      ];

      return {
        ...procedure,
        linkedDocumentCount: procedure.linkedDocumentIds.length,
        relevanceScore: calculateRelevance(fields, trimmedQuery),
        ...getSnippetMatch(fields, trimmedQuery),
      };
    })
    .filter((procedure) =>
      matchesQuery(
        [
          { value: procedure.title },
          { value: procedure.system },
          { value: procedure.toolsNeeded },
          { value: procedure.partsNeeded },
          { value: procedure.safetyNotes },
          { value: procedure.steps },
          { value: procedure.notes },
        ],
        trimmedQuery
      )
    );

  return sortSearchResults(filteredResults, sort, Boolean(trimmedQuery));
}

export function getNoteFilterOptions() {
  const vehicleId = getVehicleId();
  const notes = listNotesForVehicle(vehicleId);

  return {
    noteTypes: uniqueSorted(notes.map((note) => note.noteType)),
    relatedEntityTypes: uniqueSorted(notes.map((note) => note.relatedEntityType)),
  };
}

export function searchNotes({
  query = "",
  noteType = "",
  relatedEntityType = "",
  sort = "relevance",
}) {
  const vehicleId = getVehicleId();
  const trimmedQuery = normalizeText(query);
  const notes = listNotesForVehicle(vehicleId);

  const filteredResults = notes
    .filter((note) => !noteType || note.noteType === noteType)
    .filter((note) => !relatedEntityType || note.relatedEntityType === relatedEntityType)
    .map((note) => {
      const linkedEntityTitle =
        note.linkedDocument?.title || note.linkedSymptom?.title || note.linkedProcedure?.title || "";
      const relevanceFields = [
        { label: "Title", value: note.title, weight: 400, exactWeight: 900 },
        { label: "Content", value: note.content, weight: 260 },
        { label: "Note type", value: note.noteType, weight: 100 },
        { label: "Linked item", value: linkedEntityTitle, weight: 160 },
      ];
      const snippetFields = [
        { label: "Content", value: note.content },
        { label: "Title", value: note.title },
        { label: "Linked item", value: linkedEntityTitle },
        { label: "Note type", value: note.noteType },
      ];

      return {
        ...note,
        linkedTitle: linkedEntityTitle,
        relevanceScore: calculateRelevance(relevanceFields, trimmedQuery),
        ...getSnippetMatch(snippetFields, trimmedQuery),
      };
    })
    .filter((note) =>
      matchesQuery(
        [
          { value: note.title },
          { value: note.content },
          { value: note.noteType },
          {
            value:
              note.linkedDocument?.title ||
              note.linkedSymptom?.title ||
              note.linkedProcedure?.title ||
              "",
          },
        ],
        trimmedQuery
      )
    );

  return sortSearchResults(filteredResults, sort, Boolean(trimmedQuery));
}
