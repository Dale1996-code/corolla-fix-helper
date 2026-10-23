// Does a buffer hold a PDF, judged by its bytes rather than its name?
//
// The upload filter only sees the filename and the browser's MIME type, and both
// say "PDF" for a login page that a browser saved as `manual.pdf`. Such a file
// was stored, extracted to nothing, and kept as a document (audit 2A-09).
//
// Every PDF carries the `%PDF-` header. ISO 32000 puts it at byte 0, but
// readers accept it anywhere in the first 1024 bytes: pdf.js (this app's
// extractor) searches exactly that window, and real files exist with a few
// bytes in front of it (a mail gateway's preamble, a stray byte-order mark).
// Searching the same window keeps those files, while an HTML page, an error
// body, or an empty file never matches. This is a type check, not a validity
// check: a truncated or damaged PDF still passes, and extraction reports it.
const PDF_SIGNATURE = Buffer.from("%PDF-", "latin1");

export const PDF_SIGNATURE_SEARCH_WINDOW = 1024;

/**
 * @param {unknown} bytes
 * @returns {boolean}
 */
export function hasPdfSignature(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    return false;
  }

  const head = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    Math.min(bytes.byteLength, PDF_SIGNATURE_SEARCH_WINDOW)
  );

  return head.includes(PDF_SIGNATURE);
}
