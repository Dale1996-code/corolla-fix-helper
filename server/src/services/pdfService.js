import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

export async function extractPdfData(fileBuffer) {
  try {
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(fileBuffer),
      useSystemFonts: true,
      isEvalSupported: false,
    });

    const pdfDocument = await loadingTask.promise;
    const pageTexts = [];

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const textContent = await page.getTextContent();

      const pageText = textContent.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      if (pageText) {
        pageTexts.push(pageText);
      }
    }

    const extractedText = pageTexts.join("\n\n").trim();

    return {
      extractedText,
      extractionStatus: extractedText ? "completed" : "no_text_found",
      pageCount: pdfDocument.numPages,
    };
  } catch (error) {
    return {
      extractedText: "",
      extractionStatus: `failed: ${error.message}`,
      pageCount: null,
    };
  }
}
