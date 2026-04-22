import { Router } from "express";
import {
  getDocumentFilterOptions,
  searchDocuments,
} from "../services/documentService.js";
import {
  getNoteFilterOptions,
  getProcedureFilterOptions,
  getSymptomFilterOptions,
  searchNotes,
  searchProcedures,
  searchSymptoms,
} from "../services/searchService.js";

export const searchRouter = Router();

function getQueryValue(request, name, fallback = "") {
  return typeof request.query[name] === "string" ? request.query[name] : fallback;
}

function sendDocumentSearchResponse(request, response) {
  const query = getQueryValue(request, "q");
  const system = getQueryValue(request, "system");
  const documentType = getQueryValue(request, "documentType");
  const favorite = getQueryValue(request, "favorite");
  const sort = getQueryValue(request, "sort", "relevance");

  const results = searchDocuments({
    query,
    system,
    documentType,
    favorite,
    sort,
  });

  response.json({
    results,
    total: results.length,
    filters: getDocumentFilterOptions(),
  });
}

searchRouter.get("/documents", (request, response) => {
  sendDocumentSearchResponse(request, response);
});

searchRouter.get("/symptoms", (request, response) => {
  const results = searchSymptoms({
    query: getQueryValue(request, "q"),
    system: getQueryValue(request, "system"),
    status: getQueryValue(request, "status"),
    sort: getQueryValue(request, "sort", "relevance"),
  });

  response.json({
    results,
    total: results.length,
    filters: getSymptomFilterOptions(),
  });
});

searchRouter.get("/procedures", (request, response) => {
  const results = searchProcedures({
    query: getQueryValue(request, "q"),
    system: getQueryValue(request, "system"),
    difficulty: getQueryValue(request, "difficulty"),
    sort: getQueryValue(request, "sort", "relevance"),
  });

  response.json({
    results,
    total: results.length,
    filters: getProcedureFilterOptions(),
  });
});

searchRouter.get("/notes", (request, response) => {
  const results = searchNotes({
    query: getQueryValue(request, "q"),
    noteType: getQueryValue(request, "noteType"),
    relatedEntityType: getQueryValue(request, "relatedEntityType"),
    sort: getQueryValue(request, "sort", "relevance"),
  });

  response.json({
    results,
    total: results.length,
    filters: getNoteFilterOptions(),
  });
});

searchRouter.get("/", (request, response) => {
  sendDocumentSearchResponse(request, response);
});
