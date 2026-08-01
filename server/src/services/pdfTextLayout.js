// Column-aware reading order for PDF text items (Milestone 4, audit F3).
//
// pdfService previously did `items.map(str).join(" ")`, discarding every
// `transform` coordinate. On a two-column service-manual page that interleaves
// the columns into nonsense: a torque table row from the left column lands next
// to unrelated prose from the right, and the resulting chunk text can appear to
// state a value it does not.
//
// The fix has to segment COLUMNS FIRST, then order by y within each column.
// Doing it the other way round ("group by y-band, sort by x") produces row-wise
// interleaving (L1 R1 / L2 R2), which is not reading order and was the flaw in
// the originally proposed algorithm.
//
// Deliberately conservative: when the page does not look convincingly
// multi-column, it falls back to single-column ordering. A wrong column split is
// worse than no split, because it silently reorders correct text.
//
// A leaf module: it imports nothing.

/** Fraction of page width a gap must exceed to count as a gutter. */
const MIN_GUTTER_RATIO = 0.04;
/**
 * Absolute floor in PDF points. A real column gutter is ~20-40pt; ordinary
 * inter-word spacing is under 10pt. Without this floor, the ratio alone splits
 * narrow or degenerate pages at word gaps.
 */
const MIN_GUTTER_POINTS = 12;
/** A column must hold at least this share of the page's items. */
const MIN_COLUMN_ITEM_SHARE = 0.15;
/** A gutter must be clear across at least this share of the content height. */
const MIN_GUTTER_CLEAR_RATIO = 0.7;
/** Line grouping tolerance as a multiple of median item height. */
const LINE_TOLERANCE_RATIO = 0.6;

/**
 * Normalize a pdf.js text item into geometry we can sort.
 * transform is [a, b, c, d, e, f]; e/f are the x/y translation.
 */
function toPositionedItem(item) {
  const text = typeof item?.str === "string" ? item.str : "";

  if (!text.trim()) {
    return null;
  }

  const transform = Array.isArray(item.transform) ? item.transform : null;
  const x = transform ? Number(transform[4]) : Number(item.x);
  const y = transform ? Number(transform[5]) : Number(item.y);

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  const width = Number.isFinite(Number(item.width)) ? Number(item.width) : 0;
  const height = Number.isFinite(Number(item.height))
    ? Number(item.height)
    : transform
    ? Math.abs(Number(transform[3])) || 0
    : 0;

  return { text, x, y, width, height, right: x + width };
}

function median(values) {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Find vertical gutters: x-ranges with no item coverage, wide enough and clear
 * enough down the page to be real column separators rather than table gaps.
 */
function findColumnBoundaries(items) {
  const minX = Math.min(...items.map((item) => item.x));
  const maxX = Math.max(...items.map((item) => item.right));
  const pageWidth = maxX - minX;

  if (!(pageWidth > 0)) {
    return [];
  }

  const minY = Math.min(...items.map((item) => item.y));
  const maxY = Math.max(...items.map((item) => item.y));
  const contentHeight = maxY - minY;
  const minGutterWidth = Math.max(pageWidth * MIN_GUTTER_RATIO, MIN_GUTTER_POINTS);

  // Merge item x-intervals, then look at the holes between them.
  const intervals = items
    .map((item) => ({ start: item.x, end: Math.max(item.right, item.x + 1) }))
    .sort((left, right) => left.start - right.start);

  const merged = [];

  for (const interval of intervals) {
    const last = merged[merged.length - 1];

    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
      continue;
    }

    merged.push({ ...interval });
  }

  const boundaries = [];

  for (let index = 0; index < merged.length - 1; index += 1) {
    const gapStart = merged[index].end;
    const gapEnd = merged[index + 1].start;

    if (gapEnd - gapStart < minGutterWidth) {
      continue;
    }

    // A real gutter runs down the page. A table's internal spacing usually does
    // not, because some row spans it.
    if (contentHeight > 0) {
      const rowsCrossing = items.filter(
        (item) => item.x < gapStart && item.right > gapEnd
      ).length;

      if (rowsCrossing > 0) {
        continue;
      }

      const leftItems = items.filter((item) => item.right <= gapStart);
      const rightItems = items.filter((item) => item.x >= gapEnd);
      const spanOf = (group) =>
        group.length
          ? Math.max(...group.map((i) => i.y)) - Math.min(...group.map((i) => i.y))
          : 0;

      if (
        spanOf(leftItems) < contentHeight * MIN_GUTTER_CLEAR_RATIO ||
        spanOf(rightItems) < contentHeight * MIN_GUTTER_CLEAR_RATIO
      ) {
        continue;
      }
    }

    boundaries.push((gapStart + gapEnd) / 2);
  }

  return boundaries;
}

/** Split items into columns at the given x boundaries. */
function splitIntoColumns(items, boundaries) {
  if (!boundaries.length) {
    return [items];
  }

  const columns = Array.from({ length: boundaries.length + 1 }, () => []);

  for (const item of items) {
    let columnIndex = boundaries.findIndex((boundary) => item.x < boundary);

    if (columnIndex === -1) {
      columnIndex = boundaries.length;
    }

    columns[columnIndex].push(item);
  }

  const total = items.length;
  const populated = columns.filter((column) => column.length > 0);

  // Reject the split if any column is too small to be a real column.
  if (populated.length < 2 || populated.some((column) => column.length < total * MIN_COLUMN_ITEM_SHARE)) {
    return [items];
  }

  return populated;
}

/**
 * Order one column's items into lines: top to bottom, then left to right within
 * each line. PDF y increases upward, so descending y is top-down.
 */
function orderColumnLines(items) {
  const heights = items.map((item) => item.height).filter((height) => height > 0);
  const tolerance = Math.max((median(heights) || 8) * LINE_TOLERANCE_RATIO, 1);
  const sorted = [...items].sort((left, right) => right.y - left.y || left.x - right.x);
  const lines = [];

  for (const item of sorted) {
    const line = lines[lines.length - 1];

    if (line && Math.abs(line.y - item.y) <= tolerance) {
      line.items.push(item);
      continue;
    }

    lines.push({ y: item.y, items: [item] });
  }

  return lines.map((line) =>
    [...line.items].sort((left, right) => left.x - right.x).map((item) => item.text)
  );
}

/**
 * Build both representations of a page from pdf.js text items.
 *
 * Returns:
 *   layoutText     - line breaks preserved, columns separated. This is what a
 *                    human reading the page sees, and what an evidence quote
 *                    should be checked against.
 *   text           - whitespace-normalized single line, for retrieval and
 *                    keyword matching. Same ORDER as layoutText, which is the
 *                    actual fix: previously the order itself was wrong.
 *   columnCount    - how many columns were detected (1 when not multi-column).
 *
 * @param {any[]} items - pdf.js textContent.items
 * @returns {{ text: string, layoutText: string, columnCount: number }}
 */
export function buildPageTextFromItems(items) {
  const positioned = (Array.isArray(items) ? items : [])
    .map(toPositionedItem)
    .filter(Boolean);

  if (!positioned.length) {
    return { text: "", layoutText: "", columnCount: 0 };
  }

  const boundaries = findColumnBoundaries(positioned);
  const columns = splitIntoColumns(positioned, boundaries);

  // Columns left to right; within a column, top to bottom. Column 1 is emitted
  // in full before column 2 begins -- the property the interleaving bug broke.
  const orderedColumns = [...columns].sort(
    (left, right) =>
      Math.min(...left.map((i) => i.x)) - Math.min(...right.map((i) => i.x))
  );

  const columnBlocks = orderedColumns.map((column) =>
    orderColumnLines(column)
      .map((line) => line.join(" ").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n")
  );

  const layoutText = columnBlocks.filter(Boolean).join("\n\n");

  return {
    layoutText,
    text: layoutText.replace(/\s+/g, " ").trim(),
    columnCount: orderedColumns.length,
  };
}
