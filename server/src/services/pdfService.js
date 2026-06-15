import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { config } from "../config.js";

const OCR_COMMAND_MAX_BUFFER = 20 * 1024 * 1024;
const OCR_TEMP_PREFIX = path.join(os.tmpdir(), "corolla-fix-helper-ocr-");

function normalizeExtractedText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function countTextCharacters(text) {
  return normalizeExtractedText(text).replace(/\s+/g, "").length;
}

function shouldRunOcr(pageText) {
  return countTextCharacters(pageText) < config.ocrMinTextCharacters;
}

function mergePageText(pageText, ocrText) {
  const normalizedPageText = normalizeExtractedText(pageText);
  const normalizedOcrText = normalizeExtractedText(ocrText);

  if (!normalizedOcrText) {
    return normalizedPageText;
  }

  if (!normalizedPageText) {
    return normalizedOcrText;
  }

  const loweredPageText = normalizedPageText.toLowerCase();
  const loweredOcrText = normalizedOcrText.toLowerCase();

  if (loweredOcrText.includes(loweredPageText)) {
    return normalizedOcrText;
  }

  if (loweredPageText.includes(loweredOcrText)) {
    return normalizedPageText;
  }

  return `${normalizedPageText}\n${normalizedOcrText}`;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        maxBuffer: OCR_COMMAND_MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }

        resolve({ stdout, stderr });
      }
    );
  });
}

function isMissingOcrTool(error) {
  const message = `${error?.message || ""}\n${error?.stderr || ""}`;

  return error?.code === "ENOENT" || /ENOENT|not recognized|not found/i.test(message);
}

function formatCommandError(error) {
  return normalizeExtractedText(error?.stderr || error?.message || String(error));
}

function formatOcrWarning(error) {
  const detail = formatCommandError(error);

  if (isMissingOcrTool(error)) {
    return [
      "ocr_unavailable: OCR needs Tesseract and Poppler (pdftoppm).",
      "Install both tools or set OCR_ENABLED=false.",
      detail,
    ]
      .filter(Boolean)
      .join(" ");
  }

  return `ocr_failed: ${detail || "OCR could not read this page."}`;
}

function addUniqueWarning(warnings, warning) {
  const normalizedWarning = normalizeExtractedText(warning);

  if (normalizedWarning && !warnings.includes(normalizedWarning)) {
    warnings.push(normalizedWarning);
  }
}

async function findRenderedPageImage(tempDir, outputPrefixBaseName) {
  const files = await fs.readdir(tempDir);
  const matches = files
    .filter(
      (file) =>
        file.startsWith(`${outputPrefixBaseName}-`) &&
        file.toLowerCase().endsWith(".png")
    )
    .sort((left, right) => left.localeCompare(right));

  if (!matches.length) {
    throw new Error("Poppler did not create a page image for OCR.");
  }

  return path.join(tempDir, matches[0]);
}

export async function ocrPdfPageWithLocalTools(context = {}) {
  const { pdfPath, pageNumber } = context;

  if (!pdfPath) {
    throw new Error("A temporary PDF path is required for OCR.");
  }

  const tempDir = path.dirname(pdfPath);
  const outputPrefixBaseName = `page-${pageNumber}`;
  const outputPrefix = path.join(tempDir, outputPrefixBaseName);

  await runCommand(config.ocrPdftoppmCommand, [
    "-f",
    String(pageNumber),
    "-l",
    String(pageNumber),
    "-r",
    String(config.ocrDpi),
    "-png",
    pdfPath,
    outputPrefix,
  ]);

  const imagePath = await findRenderedPageImage(tempDir, outputPrefixBaseName);
  const { stdout } = await runCommand(config.ocrTesseractCommand, [
    imagePath,
    "stdout",
    "-l",
    config.ocrLanguage,
  ]);

  return {
    text: normalizeExtractedText(stdout),
  };
}

function buildExtractionStatus({ extractedText, ocrSucceeded, ocrWarnings }) {
  if (extractedText) {
    if (ocrSucceeded) {
      return ocrWarnings.length
        ? `completed_with_ocr_warning: ${ocrWarnings.join(" | ")}`
        : "completed_with_ocr";
    }

    return ocrWarnings.length
      ? `completed_with_warning: ${ocrWarnings.join(" | ")}`
      : "completed";
  }

  return ocrWarnings[0] || "no_text_found";
}

export async function extractPdfData(
  fileBuffer,
  { ocrPage = ocrPdfPageWithLocalTools } = {}
) {
  let tempDir = "";
  let tempPdfPath = "";

  async function getTempPdfPath() {
    if (!tempPdfPath) {
      tempDir = await fs.mkdtemp(OCR_TEMP_PREFIX);
      tempPdfPath = path.join(tempDir, "source.pdf");
      await fs.writeFile(tempPdfPath, fileBuffer);
    }

    return tempPdfPath;
  }

  try {
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(fileBuffer),
      useSystemFonts: true,
      isEvalSupported: false,
    });

    const pdfDocument = await loadingTask.promise;
    const pageTexts = [];
    const pages = [];
    const ocrWarnings = [];
    let ocrSucceeded = false;
    let ocrDisabledDueToMissingTools = false;

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const textContent = await page.getTextContent();

      const rawPageText = textContent.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      let pageText = rawPageText;

      if (shouldRunOcr(pageText) && config.ocrEnabled && !ocrDisabledDueToMissingTools) {
        try {
          const ocrResult = await ocrPage({
            fileBuffer,
            pageNumber,
            pageText,
            pdfPath: await getTempPdfPath(),
          });
          const ocrText =
            typeof ocrResult === "string" ? ocrResult : ocrResult?.text || "";

          if (ocrResult?.warning) {
            addUniqueWarning(ocrWarnings, ocrResult.warning);
          }

          if (normalizeExtractedText(ocrText)) {
            pageText = mergePageText(pageText, ocrText);
            ocrSucceeded = true;
          }
        } catch (error) {
          addUniqueWarning(ocrWarnings, formatOcrWarning(error));

          if (isMissingOcrTool(error)) {
            ocrDisabledDueToMissingTools = true;
          }
        }
      }

      if (pageText) {
        pageTexts.push(pageText);
        pages.push({
          pageNumber,
          text: pageText,
        });
      }
    }

    const extractedText = pageTexts.join("\n\n").trim();

    return {
      extractedText,
      extractionStatus: buildExtractionStatus({
        extractedText,
        ocrSucceeded,
        ocrWarnings,
      }),
      pageCount: pdfDocument.numPages,
      pages,
      ocrWarnings,
    };
  } catch (error) {
    return {
      extractedText: "",
      extractionStatus: `failed: ${error.message}`,
      pageCount: null,
      pages: [],
      ocrWarnings: [],
    };
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}
