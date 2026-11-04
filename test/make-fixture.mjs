// Build a test issue PDF from the extracted text of the real Nov 2018 TSG issue.
// Pages are split at running headers and "Contents Continued" markers.
import fs from "node:fs/promises";
import { PDFDocument, StandardFonts } from "pdf-lib";
const [src, out] = process.argv.slice(2);
const lines = (await fs.readFile(src, "utf8")).replace(/\f/g, "\n").split(/\r?\n/);
const isBreak = (l) =>
  /^\d{4} IEEE TRANSACTIONS ON SMART GRID, VOL\. 9/.test(l) ||
  /IEEE TRANSACTIONS ON SMART GRID, VOL\. 9, NO\. 6, NOVEMBER 2018 \d{4}$/.test(l) ||
  /^\(Contents Continued from/.test(l) || /^Information for Authors$/.test(l) ||
  /^IEEE POWER & ENERGY SOCIETY$/.test(l);
const pages = [[]];
for (const l of lines) { if (isBreak(l) && pages.at(-1).length) pages.push([]); pages.at(-1).push(l); }
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const safe = (s) => [...s].map((c) => { try { font.encodeText(c); return c; } catch { return "?"; } }).join("");
for (const p of pages) {
  const size = 4, lh = 4.6, h = Math.max(792, p.length * lh + 40);
  const page = doc.addPage([612, h]);
  p.forEach((l, i) => page.drawText(safe(l).slice(0, 260), { x: 20, y: h - 20 - i * lh, size, font }));
}
await fs.writeFile(out, await doc.save());
console.log(`${pages.length} pages written to ${out}`);
