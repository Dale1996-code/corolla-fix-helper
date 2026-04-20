import { Router } from "express";
import {
  getDocumentFilterOptions,
  searchDocuments,
} from "../services/documentService.js";

export const searchRouter = Router();

searchRouter.get("/", (request, response) => {
  const query = typeof request.query.q === "string" ? request.query.q : "";
  const system = typeof request.query.system === "string" ? request.query.system : "";
  const documentType =
    typeof request.query.documentType === "string" ? request.query.documentType : "";
  const favorite =
    typeof request.query.favorite === "string" ? request.query.favorite : "";
  const sort = typeof request.query.sort === "string" ? request.query.sort : "relevance";

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
});
