// Zotero plugin logic: split a full-issue PDF attachment into per-paper items.
// Bundled with esbuild into plugin/content/issue-splitter.js and loaded into
// Zotero's main window. Exposes globalThis.ZoteroIssueSplitter.

import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import { analyzeIssue, applyKnownPageRanges, doiFileName, normalizeDoi } from "./core.js";
import { extractPageTexts, openForSplit, toLocalBytes } from "./pdf.js";
import { fetchIssueFromCrossref, compareWithCrossref } from "./crossref.js";

// Run pdf.js on the main thread; Zotero's privileged context has no worker URL for it.
globalThis.pdfjsWorker = pdfjsWorker;

const PREF = "extensions.zotero-issue-splitter.";
const DELAY_MS = 400; // pause between DOI lookups to stay polite with Crossref/doi.org

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => Zotero.debug(`[Issue Splitter] ${msg}`);

function getPref(name, fallback) {
  const v = Zotero.Prefs.get(PREF + name, true);
  return v === undefined ? fallback : v;
}

/** The PDF attachment for a selected item: the item itself, or its first PDF child. */
async function getIssuePdf(item) {
  if (item.isAttachment()) return item.isPDFAttachment?.() ? item : null;
  if (item.isRegularItem()) {
    for (const id of item.getAttachments()) {
      const att = Zotero.Items.get(id);
      if (att.isPDFAttachment?.()) return att;
    }
  }
  return null;
}

async function findExistingByDoi(libraryID, doi) {
  const s = new Zotero.Search();
  s.libraryID = libraryID;
  s.addCondition("DOI", "is", doi);
  const ids = await s.search();
  return ids.length ? Zotero.Items.get(ids[0]) : null;
}

async function createItemFromDoi(doi, libraryID, collectionID) {
  const translate = new Zotero.Translate.Search();
  translate.setIdentifier({ DOI: doi });
  const translators = await translate.getTranslators();
  if (!translators.length) throw new Error("no translator for DOI");
  translate.setTranslator(translators);
  const items = await translate.translate({
    libraryID,
    collections: collectionID ? [collectionID] : false,
    saveAttachments: false,
  });
  if (!items || !items.length) throw new Error("lookup returned no item");
  return items[0];
}

/** Fallback when DOI lookup fails: a bare journal article with the DOI filled in. */
async function createStubItem(doi, info, libraryID, collectionID) {
  const item = new Zotero.Item("journalArticle");
  item.libraryID = libraryID;
  item.setField("title", `[Lookup failed] ${doi}`);
  item.setField("DOI", doi);
  if (info.journal) item.setField("publicationTitle", info.journal);
  if (info.volume) item.setField("volume", info.volume);
  if (info.number) item.setField("issue", info.number);
  if (info.year) item.setField("date", info.month ? `${info.month} ${info.year}` : info.year);
  if (info.issn) item.setField("ISSN", info.issn);
  if (collectionID) item.setCollections([collectionID]);
  item.addTag("issue-splitter:lookup-failed");
  await item.saveTx();
  return item;
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b(\w)/g, (c) => c.toUpperCase()).replace(/\bIeee\b/, "IEEE")
    .replace(/\b(On|Of|And|For|In|The)\b/g, (w) => w.toLowerCase());
}

async function createIssueCollection(win, info, fallbackName, libraryID) {
  const parts = [];
  if (info.journal) parts.push(titleCase(info.journal));
  if (info.volume && info.number) parts.push(`${info.volume}(${info.number})`);
  if (info.month || info.year) parts.push([info.month && titleCase(info.month), info.year].filter(Boolean).join(" "));
  const name = parts.length ? parts.join(" ") : fallbackName;

  const selected = win.ZoteroPane.getSelectedCollection?.();
  const coll = new Zotero.Collection();
  coll.libraryID = libraryID;
  coll.name = name;
  if (selected && selected.libraryID === libraryID) coll.parentID = selected.id;
  await coll.saveTx();
  return coll;
}

function progress(title) {
  const pw = new Zotero.ProgressWindow({ closeOnClick: false });
  pw.changeHeadline(title);
  const line = new pw.ItemProgress("attachmentPDF", "Starting…");
  pw.show();
  return {
    set(text, pct) {
      line.setText(text);
      if (pct != null) line.setProgress(Math.max(0, Math.min(100, pct)));
    },
    done(text) {
      line.setText(text);
      line.setProgress(100);
      pw.startCloseTimer(8000);
    },
    error(text) {
      line.setError();
      line.setText(text);
      pw.startCloseTimer(15000);
    },
  };
}

async function splitIssue(win, selectedItem) {
  const att = await getIssuePdf(selectedItem);
  if (!att) {
    Services.prompt.alert(win, "Split Journal Issue", "Select a PDF attachment, or an item with a PDF attachment.");
    return;
  }
  const path = await att.getFilePathAsync();
  if (!path) {
    Services.prompt.alert(win, "Split Journal Issue", "The PDF file is not available locally.");
    return;
  }

  const libraryID = att.libraryID;
  const pg = progress("Split Journal Issue");
  try {
    pg.set("Reading PDF…", 2);
    const bytes = toLocalBytes(await IOUtils.read(path));
    const texts = await extractPageTexts(bytes, pdfjsLib, (i, n) =>
      pg.set(`Reading page ${i} of ${n}…`, Math.round((i / n) * 30))
    );
    const a = analyzeIssue(texts);

    let titles = new Map();
    let crNote = "";
    if (getPref("useCrossref", true) && a.info.issn) {
      try {
        pg.set("Checking issue against Crossref…", 32);
        const cr = await fetchIssueFromCrossref(a.info);
        const cmp = compareWithCrossref(a, cr);
        applyKnownPageRanges(a.papers, new Map([...cmp.cr].map(([k, v]) => [k, v.page])));
        titles = new Map([...cmp.cr].map(([k, v]) => [k, v.title]));
        crNote = `\nCrossref lists ${cr.length} items for this issue` +
          (cmp.missingFromPdf.length ? `; ${cmp.missingFromPdf.length} of them are not in this PDF.` : ".");
      } catch (e) {
        crNote = `\nCrossref check failed: ${e.message}`;
      }
    }

    if (!a.papers.length) {
      pg.error("No papers found.");
      Services.prompt.alert(win, "Split Journal Issue", ["No papers found in this PDF.", ...a.warnings].join("\n\n"));
      return;
    }

    const existing = [];
    for (const p of a.papers) if (await findExistingByDoi(libraryID, p.doi)) existing.push(p.doi);

    const msg =
      `Found ${a.papers.length} papers` +
      (a.other.length ? ` (plus ${a.other.length} front/back matter items, which will be skipped)` : "") +
      `.\nThe table of contents lists about ${a.tocCount} entries.` + crNote +
      (existing.length ? `\n\n${existing.length} of these DOIs are already in this library and will be skipped.` : "") +
      (a.warnings.length ? `\n\nWarnings:\n- ${a.warnings.join("\n- ")}` : "") +
      `\n\nCreate ${a.papers.length - existing.length} items with their own PDFs in a new collection?`;
    if (!Services.prompt.confirm(win, "Split Journal Issue", msg)) {
      pg.done("Cancelled.");
      return;
    }

    const coll = await createIssueCollection(win, a.info, att.getField("title") || "Split issue", libraryID);
    const splitter = await openForSplit(bytes);
    const existingSet = new Set(existing.map(normalizeDoi));
    let created = 0, stubs = 0, skipped = 0;
    const failures = [];

    for (let i = 0; i < a.papers.length; i++) {
      const p = a.papers[i];
      const pct = 35 + Math.round(((i + 1) / a.papers.length) * 64);
      if (existingSet.has(normalizeDoi(p.doi))) {
        skipped++;
        const old = await findExistingByDoi(libraryID, p.doi);
        if (old && !old.isInCollection(coll.id)) {
          old.addToCollection(coll.id);
          await old.saveTx();
        }
        continue;
      }
      pg.set(`Paper ${i + 1} of ${a.papers.length}: ${p.doi}`, pct);

      let item;
      try {
        item = await createItemFromDoi(p.doi, libraryID, coll.id);
        created++;
      } catch (e) {
        log(`DOI lookup failed for ${p.doi}: ${e}`);
        failures.push(p.doi);
        item = await createStubItem(p.doi, a.info, libraryID, coll.id);
        stubs++;
      }

      try {
        const title = titles.get(normalizeDoi(p.doi)) || item.getField("title") || p.doi;
        const out = await splitter.extract(p.startPage, p.endPage, title);
        const tmp = PathUtils.join(PathUtils.tempDir, doiFileName(p.doi));
        await IOUtils.write(tmp, out);
        await Zotero.Attachments.importFromFile({ file: tmp, parentItemID: item.id, title: "Full Text PDF" });
        await IOUtils.remove(tmp, { ignoreAbsent: true });
      } catch (e) {
        log(`Attaching split PDF failed for ${p.doi}: ${e}`);
        failures.push(`${p.doi} (PDF)`);
      }
      await sleep(DELAY_MS);
    }

    if (getPref("tagSource", true)) {
      att.addTag("issue-splitter:split");
      await att.saveTx();
    }

    const summary = `${created} created, ${stubs} placeholders, ${skipped} already in library.`;
    pg.done(summary);
    if (failures.length) {
      Services.prompt.alert(
        win,
        "Split Journal Issue",
        `${summary}\n\nThese need attention (placeholder items are tagged issue-splitter:lookup-failed):\n${failures.join("\n")}`
      );
    }
  } catch (e) {
    log(e);
    pg.error(`Failed: ${e.message || e}`);
    Services.prompt.alert(win, "Split Journal Issue", `Failed: ${e.message || e}`);
  }
}

globalThis.ZoteroIssueSplitter = { splitIssue, getIssuePdf };
