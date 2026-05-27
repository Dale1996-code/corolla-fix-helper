import { Router } from "express";
import { askQuestionUsingDocuments } from "../services/aiAnswerService.js";

export function createAskRouter({ askQuestion = askQuestionUsingDocuments } = {}) {
  const router = Router();

  router.post("/", async (request, response) => {
    const question = typeof request.body?.question === "string" ? request.body.question.trim() : "";

    if (!question) {
      response.status(400).json({
        error: "Question is required.",
      });
      return;
    }

    try {
      const result = await askQuestion(question);

      response.json({
        question,
        status: result.status,
        answer: result.answer,
        citations: result.citations,
      });
    } catch (error) {
      response.status(500).json({
        error: error.message || "Could not answer this question.",
      });
    }
  });

  return router;
}

export const askRouter = createAskRouter();
