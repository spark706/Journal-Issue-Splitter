// Crossref lookup for an issue: lists every DOI Crossref has for a given
// ISSN + volume + issue, with titles and page ranges. Used to cross-check
// what was found in the PDF and to tighten split page ranges.

const UA = "zotero-issue-splitter/0.3 (Zotero plugin; Crossref issue check)";

export async function fetchIssueFromCrossref({ issn, volume, number, year }, fetchFn = fetch) {
  if (!issn || !volume || !number || !year) {
    throw new Error("Need ISSN, volume, number and year to query Crossref.");
  }
  const y = Number(year);
  // Early-access papers can be published online up to ~2 years before the print issue.
  const filter = `from-pub-date:${y - 2}-01-01,until-pub-date:${y}-12-31`;
  const select = "DOI,title,volume,issue,page,type";
  let cursor = "*";
  const found = [];
  for (let guard = 0; guard < 20; guard++) {
    const url =
      `https://api.crossref.org/journals/${encodeURIComponent(issn)}/works` +
      `?filter=${filter}&select=${select}&rows=1000&cursor=${encodeURIComponent(cursor)}`;
    const res = await fetchFn(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`Crossref HTTP ${res.status}`);
    const json = await res.json();
    const items = json?.message?.items ?? [];
    for (const it of items) {
      if (String(it.volume) === String(volume) && String(it.issue) === String(number)) {
        found.push({
          doi: it.DOI,
          title: Array.isArray(it.title) ? it.title[0] : it.title,
          page: it.page,
          type: it.type,
        });
      }
    }
    const next = json?.message?.["next-cursor"];
    if (!items.length || !next || next === cursor) break;
    cursor = next;
  }
  return found;
}

/** Compare PDF results with Crossref's list for the same issue. */
export function compareWithCrossref(analysis, crossrefItems) {
  const norm = (d) => d.toLowerCase();
  const pdfAll = new Set([...analysis.papers, ...analysis.other].map((p) => norm(p.doi)));
  const cr = new Map(crossrefItems.map((c) => [norm(c.doi), c]));
  const missingFromPdf = crossrefItems.filter((c) => !pdfAll.has(norm(c.doi)));
  const notInCrossref = analysis.papers.filter((p) => !cr.has(norm(p.doi)));
  return { cr, missingFromPdf, notInCrossref };
}
