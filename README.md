# Journal Issue Splitter

Splits a full-issue journal PDF (for example, an IEEE Transactions issue downloaded as one file) into one PDF per paper, and gets each paper's DOI from the "Digital Object Identifier" line printed on its first page.

There are two ways to use it. Both share the same core code in `src/`.

| | Zotero plugin (`dist\*.xpi`) | Command-line script (`cli\split-issues.mjs`) |
|---|---|---|
| Creates Zotero items | Yes, by DOI lookup | No. You paste `dois.txt` into Zotero |
| Attaches per-paper PDFs | Yes | Writes them to a folder; you attach them yourself |
| Batch over a folder of issues | One issue at a time | Yes |
| Needs Node.js | No | Yes |

## How it works

1. Reads the text of every page.
2. Finds each "Digital Object Identifier 10.xxxx/..." line. DOIs in reference lists don't match because they lack that phrase.
3. A page with "Manuscript received", "Date of publication", or "Paper no." is the first page of a paper. Other DOI items (cover/TOC, Information for Authors, editorials) are listed separately and skipped.
4. Each paper runs from its first page to the page before the next DOI item.
5. Cross-checks the paper count against the table of contents, and lists any TOC start pages with no DOI in the PDF.
6. Optionally checks Crossref for the same ISSN, volume, and issue. It reports items Crossref has that the PDF lacks, and uses Crossref page counts to trim trailing pages.

## Zotero plugin (Zotero 7 through 10)

Install:
1. In Zotero, open **Tools > Plugins**.
2. Click the gear icon, choose **Install Plugin From File…**, and select `journal-issue-splitter-0.3.0.xpi`.

Use:
1. Import a full-issue PDF into Zotero (drag it in, or use an existing item that has it attached).
2. Optional: select one collection first. The new issue collection is created inside it. If several collections are selected (Zotero 10), it is created at the top level of the library.
3. Right-click the PDF (or its parent item) and choose **Split Journal Issue into Papers…**.
4. Review the confirmation (paper count, TOC count, Crossref check, duplicates, warnings), then click OK.

What it creates:
- A collection named like "IEEE Transactions on Smart Grid 9(6) November 2018".
- One item per paper, created through Zotero's normal DOI lookup, with its own PDF attached.
- DOIs already in the library are skipped and added to the new collection.
- If a DOI lookup fails, a placeholder item is created with the DOI, journal, volume, and issue, tagged `issue-splitter:lookup-failed`. Use **Retrieve Metadata** or fix it later.
- The source issue PDF is tagged `issue-splitter:split`.

Settings (Zotero **Settings > Advanced > Config Editor**):
- `extensions.zotero-issue-splitter.useCrossref` (default true)
- `extensions.zotero-issue-splitter.tagSource` (default true)

## Command-line script (Windows)

One-time setup:
1. Install Node.js LTS from https://nodejs.org (version 20 or later).
2. Unzip this project, open PowerShell in the project folder, and run:

```powershell
npm install
```

Run on a folder of issue PDFs:

```powershell
node cli\split-issues.mjs "C:\Papers\IEEE issues" --out "C:\Papers\split" --crossref
```

Options:
- `--out <folder>`: output folder (default: `split-output` next to the input)
- `--no-split`: only list DOIs; don't write per-paper PDFs
- `--crossref`: check against Crossref and trim page ranges (needs internet)
- `--include-other`: also write PDFs for cover and author-information items

Output, per issue (a subfolder named after the input file):
- `dois.txt`: paper DOIs, one per line. Paste into Zotero's **Add Item by Identifier** (magic wand).
- `10.1109_TSG.2017.2668381.pdf` …: one PDF per paper, named by DOI.
- `report.csv`: DOI, type, PDF page range, printed start page, Crossref title, file name.
- `toc-pages-not-found.txt` and `missing-from-pdf.txt`: only written when something is missing.

Across all issues:
- `all-dois.txt` and `summary.csv`. Check the `warnings` column in `summary.csv` first.

## Known limits

- **Scanned issues with no text layer** produce no DOIs. Run OCR first, or rely on Crossref.
- **Older issues** (roughly pre-2000) may not print a DOI on each paper. The warning says so.
- **Large files**: a 1,500-page issue is read in one pass. In Zotero this can make the window unresponsive for a minute or more. Very large PDFs may need several GB of memory.
- **Trailing pages**: without Crossref, any blank or ad pages after a paper stay attached to that paper.
- **Rate limits**: the plugin pauses briefly between DOI lookups. Splitting many issues back to back still sends many requests to doi.org and Crossref.
- **Journals other than IEEE** work if they print the same "Digital Object Identifier" footnote. Others need a new pattern in `src/core.js`.

## Development

```powershell
npm install
npm test          # unit tests for the core logic
npm run build     # bundle the plugin and write dist\journal-issue-splitter-<version>.xpi
```

- `src/core.js`: DOI detection, page ranges, issue info, TOC parsing (no dependencies)
- `src/pdf.js`: text extraction (pdf.js) and splitting (pdf-lib)
- `src/crossref.js`: Crossref issue lookup and comparison
- `src/zotero-plugin.js`: Zotero item creation, attachment, and UI
- `plugin/`: manifest, bootstrap, prefs, and locale files packaged into the .xpi
- `test/`: unit tests, a test-PDF builder, and a simulation that runs the plugin bundle against stand-ins for Zotero's APIs
