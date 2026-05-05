import { Router } from "express";
import { db } from "../database.js";

export const healthRouter = Router();

healthRouter.get("/", (_request, response) => {
  try {
    db.prepare("SELECT 1").get();
    response.json({
      status: "ok",
      message: "Corolla Fix Helper server is running.",
    });
  } catch {
    response.status(503).json({
      status: "error",
      message: "Database is unavailable.",
    });
  }
});
