// PDF helpers shared by the CLI and the Zotero plugin.
// pdfjs is passed in because Node and the Zotero bundle load it differently.
import { PDFDocument } from "pdf-lib";

/**
 * Bytes from another JS realm (e.g., Zotero's IOUtils.read) fail pdf-lib's
 * instanceof checks. Copy into this realm only when needed.
 */
export function toLocalBytes(bytes) {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

/** Extract text for each page. Returns string[] (one entry per page). */
export async function extractPageTexts(bytes, pdfjs, onProgress, extraOptions = {}) {
  const data = toLocalBytes(bytes).slice();
  const doc = await pdfjs.getDocument({
    data,
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
    ...extraOptions,
  }).promise;
  const texts = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let s = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        s += item.str;
        s += item.hasEOL ? "\n" : " ";
      }
      texts.push(s);
      page.cleanup();
      if (onProgress && i % 25 === 0) onProgress(i, doc.numPages);
    }
  } finally {
    await doc.destroy();
  }
  return texts;
}

/** Load once, then cut out page ranges. Ranges are 0-based inclusive. */
export async function openForSplit(bytes) {
  const src = await PDFDocument.load(toLocalBytes(bytes), { ignoreEncryption: true, updateMetadata: false });
  return {
    pageCount: src.getPageCount(),
    async extract(startPage, endPage, title) {
      const out = await PDFDocument.create();
      const idx = [];
      for (let i = startPage; i <= endPage; i++) idx.push(i);
      const pages = await out.copyPages(src, idx);
      pages.forEach((p) => out.addPage(p));
      if (title) out.setTitle(title);
      return out.save();
    },
  };
}
