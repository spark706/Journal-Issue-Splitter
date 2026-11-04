#!/usr/bin/env node
// Split full-issue journal PDFs into one PDF per paper and list their DOIs.
//
// Usage (Windows PowerShell or Command Prompt):
//   node cli\split-issues.mjs "C:\Papers\IEEE TSG 2018" --out "C:\Papers\split"
// Options:
//   --out <dir>     Output folder (default: .\split-output next to the input)
//   --no-split      Only list DOIs, do not write per-paper PDFs
//   --crossref      Cross-check each issue against Crossref and tighten page ranges
//   --include-other Also write PDFs for non-paper items (cover, author info)

import fs from "node:fs/promises";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { analyzeIssue, applyKnownPageRanges, doiFileName, normalizeDoi } from "../src/core.js";
import { extractPageTexts, openForSplit } from "../src/pdf.js";
import { fetchIssueFromCrossref, compareWithCrossref } from "../src/crossref.js";

const pdfjs = { getDocument };
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const standardFontDataUrl =
  path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") + path.sep;

function parseArgs(argv) {
  const opts = { inputs: [], out: null, split: true, crossref: false, includeOther: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") opts.out = argv[++i];
    else if (a === "--no-split") opts.split = false;
    else if (a === "--crossref") opts.crossref = true;
    else if (a === "--include-other") opts.includeOther = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else opts.inputs.push(a);
  }
  return opts;
}

async function listPdfs(inputs) {
  const files = [];
  for (const p of inputs) {
    const st = await fs.stat(p);
    if (st.isDirectory()) {
      for (const f of await fs.readdir(p)) {
        if (f.toLowerCase().endsWith(".pdf")) files.push(path.join(p, f));
      }
    } else files.push(p);
  }
  return files.sort();
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function issueLabel(info, fallback) {
  if (info.volume && info.number) {
    return `Vol${info.volume}-No${info.number}${info.year ? "-" + info.year : ""}`;
  }
  return fallback;
}

async function processFile(file, opts) {
  const base = path.basename(file, path.extname(file));
  console.log(`\n== ${base}`);
  const bytes = new Uint8Array(await fs.readFile(file));
  const texts = await extractPageTexts(bytes, pdfjs, (i, n) =>
    process.stdout.write(`\r   reading page ${i}/${n}`),
    { standardFontDataUrl }
  );
  process.stdout.write("\r");
  const a = analyzeIssue(texts);
  const label = issueLabel(a.info, base);
  const outDir = path.join(opts.out, `${base}`);
  await fs.mkdir(outDir, { recursive: true });

  let titles = new Map();
  if (opts.crossref) {
    try {
      const cr = await fetchIssueFromCrossref(a.info);
      const cmp = compareWithCrossref(a, cr);
      applyKnownPageRanges(a.papers, new Map([...cmp.cr].map(([k, v]) => [k, v.page])));
      titles = new Map([...cmp.cr].map(([k, v]) => [k, v.title]));
      console.log(`   Crossref lists ${cr.length} items for this issue.`);
      if (cmp.missingFromPdf.length) {
        a.warnings.push(
          `${cmp.missingFromPdf.length} Crossref items for this issue were not found in the PDF (see missing-from-pdf.txt).`
        );
        await fs.writeFile(
          path.join(outDir, "missing-from-pdf.txt"),
          cmp.missingFromPdf.map((c) => `${c.doi}\t${c.page ?? ""}\t${c.title ?? ""}`).join("\r\n") + "\r\n"
        );
      }
      if (cmp.notInCrossref.length) {
        a.warnings.push(`${cmp.notInCrossref.length} DOIs from the PDF were not in Crossref's list for this issue.`);
      }
    } catch (e) {
      a.warnings.push(`Crossref check failed: ${e.message}`);
    }
  }

  const rows = [["doi", "kind", "pdf_first_page", "pdf_last_page", "printed_first_page", "title", "file"]];
  let splitter = null;
  if (opts.split) splitter = await openForSplit(bytes);
  const targets = opts.includeOther ? [...a.papers, ...a.other] : a.papers;
  for (const item of [...a.papers, ...a.other]) {
    const title = titles.get(normalizeDoi(item.doi)) ?? "";
    let fileName = "";
    if (splitter && targets.includes(item)) {
      fileName = doiFileName(item.doi);
      const out = await splitter.extract(item.startPage, item.endPage, title || item.doi);
      await fs.writeFile(path.join(outDir, fileName), out);
    }
    rows.push([item.doi, item.kind, item.startPage + 1, item.endPage + 1, item.printedStartPage ?? "", title, fileName]);
  }

  await fs.writeFile(path.join(outDir, "dois.txt"), a.papers.map((p) => p.doi).join("\r\n") + "\r\n");
  if (a.tocMissing.length) {
    await fs.writeFile(
      path.join(outDir, "toc-pages-not-found.txt"),
      "Printed start pages listed in the table of contents with no DOI found in this PDF:\r\n" +
        a.tocMissing.join("\r\n") + "\r\n"
    );
  }
  await fs.writeFile(path.join(outDir, "report.csv"), rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n");

  console.log(
    `   ${label}: ${a.pageCount} pages, ${a.papers.length} papers, ${a.other.length} other DOI items, TOC lists ~${a.tocCount}`
  );
  if (a.tocMissing.length) {
    console.log(`   ${a.tocMissing.length} TOC start pages have no DOI in this PDF (see toc-pages-not-found.txt)`);
  }
  for (const w of a.warnings) console.log(`   WARNING: ${w}`);
  return { file, label, analysis: a };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.inputs.length) {
    console.log(
      'Usage: node cli\\split-issues.mjs <pdf-or-folder> [...] [--out <dir>] [--no-split] [--crossref] [--include-other]'
    );
    process.exit(opts.help ? 0 : 1);
  }
  const files = await listPdfs(opts.inputs);
  opts.out ??= path.join(path.dirname(path.resolve(files[0] ?? ".")), "split-output");
  await fs.mkdir(opts.out, { recursive: true });

  const summary = [["file", "issue", "pages", "papers", "other", "toc_entries", "warnings"]];
  const allDois = [];
  for (const f of files) {
    try {
      const r = await processFile(f, opts);
      allDois.push(...r.analysis.papers.map((p) => p.doi));
      summary.push([
        path.basename(f), r.label, r.analysis.pageCount, r.analysis.papers.length,
        r.analysis.other.length, r.analysis.tocCount, r.analysis.warnings.join(" | "),
      ]);
    } catch (e) {
      console.log(`   ERROR: ${e.message}`);
      summary.push([path.basename(f), "", "", "", "", "", `ERROR: ${e.message}`]);
    }
  }
  await fs.writeFile(path.join(opts.out, "all-dois.txt"), allDois.join("\r\n") + "\r\n");
  await fs.writeFile(path.join(opts.out, "summary.csv"), summary.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n");
  console.log(`\nDone. ${allDois.length} paper DOIs from ${files.length} files. Output: ${opts.out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
