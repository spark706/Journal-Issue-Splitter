// Core analysis for full-issue journal PDFs (IEEE Transactions style).
// Pure logic: takes an array of per-page text strings, no PDF or Zotero dependencies,
// so the same code runs in the Node CLI and inside the Zotero plugin.

const MONTHS =
  "JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER";

// The footnote line IEEE prints on the first page of every item in an issue.
const DOI_LINE_RE =
  /Digital\s+Object\s+Identifier\s*:?\s*(10\.\d{4,9}\/[^\s"<>]+)/gi;

// Signals that a page is the first page of a research paper or letter,
// as opposed to the cover, an editorial, or "Information for Authors".
const PAPER_SIGNAL_RE = /Manuscript\s+received|Date\s+of\s+publication|Paper\s+no\./i;

export function cleanDoi(raw) {
  return raw.replace(/[.,;:)\]]+$/, "").trim();
}

export function normalizeDoi(doi) {
  return cleanDoi(doi).toLowerCase();
}

/** Find every "Digital Object Identifier" line and the page it sits on. */
export function findDoiPages(pageTexts) {
  const hits = [];
  const seen = new Set();
  pageTexts.forEach((text, pageIndex) => {
    DOI_LINE_RE.lastIndex = 0;
    let m;
    while ((m = DOI_LINE_RE.exec(text)) !== null) {
      const doi = cleanDoi(m[1]);
      const key = doi.toLowerCase();
      if (seen.has(key)) continue; // same DOI printed twice; keep first page
      seen.add(key);
      hits.push({ doi, pageIndex });
    }
  });
  return hits;
}

/** Pull journal, volume, number, month, year and ISSN from the cover and running headers. */
export function parseIssueInfo(pageTexts) {
  const info = {};
  const front = pageTexts.slice(0, 8).join("\n");
  const cover = front.match(
    new RegExp(`(${MONTHS})\\s+(\\d{4})\\s+VOLUME\\s+(\\d+)\\s+NUMBER\\s+(\\d+)`, "i")
  );
  if (cover) {
    info.month = cover[1];
    info.year = cover[2];
    info.volume = cover[3];
    info.number = cover[4];
  }
  const issn = front.match(/ISSN\s+(\d{4}-\d{3}[\dXx])/);
  if (issn) info.issn = issn[1].toUpperCase();

  // Running header, e.g. "IEEE TRANSACTIONS ON SMART GRID, VOL. 9, NO. 6, NOVEMBER 2018"
  const headerRe = new RegExp(
    `(IEEE [A-Z][A-Z ,&\\-]+?),\\s*VOL\\.\\s*(\\d+),\\s*NO\\.\\s*(\\d+),\\s*(${MONTHS})\\s+(\\d{4})`
  );
  for (const t of pageTexts) {
    const h = t.match(headerRe);
    if (h) {
      info.journal = h[1].trim();
      info.volume ??= h[2];
      info.number ??= h[3];
      info.month ??= h[4];
      info.year ??= h[5];
      break;
    }
  }
  return info;
}

/** Start pages listed in the table of contents (lines with dot leaders ending in a page number). */
export function parseTocStartPages(pageTexts, beforePage) {
  const tocLine = /(?:\.\s?){3,}.*\s(\d{1,5})\s*$/;
  const pages = [];
  for (const t of pageTexts.slice(0, Math.max(beforePage, 0))) {
    for (const line of t.split(/\r?\n/)) {
      const m = line.match(tocLine);
      if (m) pages.push(Number(m[1]));
    }
  }
  return pages;
}

export function countTocEntries(pageTexts, beforePage) {
  return parseTocStartPages(pageTexts, beforePage).length;
}

/** Printed page number from a running header, if the page has one. */
export function printedPageNumber(text) {
  const head = text.split(/\r?\n/).slice(0, 3).join(" ");
  const tail = text.split(/\r?\n/).slice(-3).join(" ");
  let m = head.match(/^\s*(\d{1,5})\s+IEEE\s/);
  if (m) return Number(m[1]);
  m = (head + " " + tail).match(new RegExp(`(?:${MONTHS})\\s+\\d{4}\\s+(\\d{1,5})\\b`));
  return m ? Number(m[1]) : null;
}

/**
 * Analyze a full-issue PDF given its per-page text.
 * Returns papers with 0-based inclusive page ranges, other DOI items
 * (cover, editorials, information for authors), issue info, and warnings.
 */
export function analyzeIssue(pageTexts) {
  const warnings = [];
  const pageCount = pageTexts.length;
  const hits = findDoiPages(pageTexts);
  const info = parseIssueInfo(pageTexts);

  const items = hits.map((h, i) => {
    const next = hits[i + 1];
    const endPage = next ? Math.max(h.pageIndex, next.pageIndex - 1) : pageCount - 1;
    const text = pageTexts[h.pageIndex] || "";
    const kind = PAPER_SIGNAL_RE.test(text) ? "paper" : "other";
    return {
      doi: h.doi,
      kind,
      startPage: h.pageIndex,
      endPage,
      printedStartPage: printedPageNumber(text),
    };
  });

  // Two DOIs on one page means the earlier item gets zero pages of its own.
  for (let i = 0; i + 1 < items.length; i++) {
    if (items[i].startPage === items[i + 1].startPage && items[i].kind === "paper") {
      warnings.push(
        `${items[i].doi} shares page ${items[i].startPage + 1} with ${items[i + 1].doi}; its split PDF may be wrong.`
      );
    }
  }

  const papers = items.filter((x) => x.kind === "paper");
  const other = items.filter((x) => x.kind !== "paper");
  const firstPaperPage = papers.length ? papers[0].startPage : pageCount;
  const tocPages = parseTocStartPages(pageTexts, firstPaperPage);
  const tocCount = tocPages.length;
  const foundPrinted = new Set(papers.map((p) => p.printedStartPage).filter((n) => n != null));
  // TOC entries whose start page has no DOI line in the PDF (only meaningful
  // when printed page numbers could be read from the running headers).
  const tocMissing = foundPrinted.size ? tocPages.filter((n) => !foundPrinted.has(n)) : [];

  if (hits.length === 0) {
    warnings.push(
      "No 'Digital Object Identifier' lines found. The PDF may be scanned (no text layer) or predate IEEE's DOI footnotes. Use the Crossref fallback."
    );
  }
  if (tocCount && papers.length && tocCount !== papers.length) {
    warnings.push(
      `Table of contents lists about ${tocCount} entries but ${papers.length} papers were found. The PDF may be partial, or the TOC count may be off.`
    );
  }
  const last = items[items.length - 1];
  if (last && last.kind === "paper" && last.endPage - last.startPage > 30) {
    warnings.push(
      `Last paper ${last.doi} runs ${last.endPage - last.startPage + 1} pages to the end of the file; trailing pages may not belong to it.`
    );
  }

  return { info, pageCount, papers, other, tocCount, tocPages, tocMissing, warnings };
}

/**
 * Tighten page ranges using known page counts (e.g., from Crossref "5482-5493").
 * knownPages: Map of normalized DOI -> "first-last" string.
 */
export function applyKnownPageRanges(papers, knownPages) {
  for (const p of papers) {
    const pages = knownPages.get(normalizeDoi(p.doi));
    const m = pages && String(pages).match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (!m) continue;
    const count = Number(m[2]) - Number(m[1]) + 1;
    if (count > 0) p.endPage = Math.min(p.endPage, p.startPage + count - 1);
  }
  return papers;
}

/** Safe file name for a DOI, e.g. 10.1109_TSG.2017.2668381.pdf */
export function doiFileName(doi, ext = ".pdf") {
  return doi.replace(/[\/\\:*?"<>|]+/g, "_") + ext;
}
