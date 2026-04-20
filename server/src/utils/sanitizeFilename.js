import path from "node:path";

const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

function removeUnsafeCharacters(value) {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/[. ]+$/g, "")
    .replace(/^[-. ]+/g, "");
}

export function sanitizeFilename(filename) {
  const extension = path.extname(filename || "").toLowerCase();
  const baseName = path.basename(filename || "document", extension);
  let safeBaseName = removeUnsafeCharacters(baseName);

  if (!safeBaseName) {
    safeBaseName = "document";
  }

  if (WINDOWS_RESERVED_NAMES.has(safeBaseName.toUpperCase())) {
    safeBaseName = `${safeBaseName}-file`;
  }

  return `${safeBaseName}${extension}`;
}

export function createStoredFilename(filename) {
  const safeFilename = sanitizeFilename(filename);
  const extension = path.extname(safeFilename);
  const baseName = path.basename(safeFilename, extension);
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return `${baseName}-${uniqueSuffix}${extension}`;
}

export function deriveTitleFromFilename(filename) {
  const extension = path.extname(filename || "");
  const baseName = path.basename(filename || "document", extension);

  return (
    baseName
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "Untitled Document"
  );
}
