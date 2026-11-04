// Run the bundled plugin script with stand-ins for Zotero's APIs.
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import os from "node:os";
const fixture = path.resolve("test/fixture-issue.pdf");
const log = [];
let nextId = 1;
const attachments = [];
class FakeItem {
  constructor(type = "journalArticle") { this.id = nextId++; this.type = type; this.fields = {}; this.tags = []; this.colls = []; this.libraryID = 1; }
  isAttachment() { return this.type === "attachment"; } isPDFAttachment() { return this.type === "attachment"; }
  isRegularItem() { return this.type !== "attachment"; } getAttachments() { return []; }
  setField(k, v) { this.fields[k] = v; } getField(k) { return this.fields[k] ?? ""; }
  addTag(t) { this.tags.push(t); } setCollections(c) { this.colls = c; }
  isInCollection(id) { return this.colls.includes(id); } addToCollection(id) { this.colls.push(id); }
  async saveTx() { } async getFilePathAsync() { return fixture; }
}
const issueAtt = new FakeItem("attachment"); issueAtt.setField("title", "issue.pdf");
const existingDoi = "10.1109/TSG.2017.2680436";
const failDoi = "10.1109/TSG.2017.2690360";
const Zotero = {
  debug: (m) => log.push("debug: " + m),
  Prefs: { get: () => undefined },
  Search: class { addCondition(f, op, v) { this.v = v; } async search() { return this.v === existingDoi ? [999] : []; } },
  Items: { get: (id) => { const it = new FakeItem(); it.id = id; return it; } },
  Translate: { Search: class {
    setIdentifier(x) { this.doi = x.DOI; } async getTranslators() { return [{}]; } setTranslator() {}
    async translate(o) { if (this.doi === failDoi) throw new Error("404"); const it = new FakeItem(); it.setField("title", "T " + this.doi); it.colls = o.collections; return [it]; } } },
  Item: FakeItem,
  Collection: class { constructor() { this.id = 500; } async saveTx() { log.push(`collection: ${this.name} (parentID ${this.parentID ?? "none"})`); } },
  Attachments: { importFromFile: async (o) => { const b = fs.readFileSync(o.file); attachments.push({ parent: o.parentItemID, bytes: b.length, file: path.basename(o.file) }); } },
  ProgressWindow: class { constructor() { const self = this; this.ItemProgress = class { setText(t) { self.last = t; } setProgress() {} setError() { log.push("progress error"); } }; } changeHeadline() {} show() {} startCloseTimer() { log.push("progress: " + this.last); } },
};
const Services = { prompt: { confirm: (w, t, m) => { log.push("confirm:\n" + m); return true; }, alert: (w, t, m) => log.push("alert:\n" + m) } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sim-"));
const IOUtils = { read: async (p) => new Uint8Array(fs.readFileSync(p)), write: async (p, b) => fs.writeFileSync(p, b), remove: async (p) => fs.rmSync(p, { force: true }) };
const PathUtils = { join: path.join, tempDir: tmp };
const crossrefPages = { "10.1109/tsg.2017.2668381": "5482-5493" };
const fetch = async (url) => ({ ok: true, json: async () => ({ message: { "next-cursor": "x", items: url.includes("cursor=*") ? [
  { DOI: "10.1109/tsg.2017.2668381", title: ["Bifurcation Analysis"], volume: "9", issue: "6", page: crossrefPages["10.1109/tsg.2017.2668381"] },
  { DOI: "10.1109/tsg.2017.2720683", title: ["Not in excerpt"], volume: "9", issue: "6", page: "6721-6730" }] : [] } }) });
// SIM_PANE picks which collection-selection API the fake window offers:
//   z7    - only getSelectedCollection() (Zotero 7 to 9)
//   z10-1 - getSelectedCollections() with one collection selected
//   z10-2 - getSelectedCollections() with two selected; getSelectedCollection() throws, as in Zotero 10
const parent = { id: 42, libraryID: 1 };
const panes = {
  z7: { getSelectedCollection: () => parent },
  "z10-1": { getSelectedCollections: () => [parent], getSelectedCollection: () => parent },
  "z10-2": {
    getSelectedCollections: () => [parent, { id: 43, libraryID: 1 }],
    getSelectedCollection: () => { throw new Error("ZoteroPane.getSelectedCollection() was removed -- use ZoteroPane.getSelectedCollections()"); },
  },
};
const mode = process.env.SIM_PANE || "z10-2";
const win = { ZoteroPane: panes[mode] };
const webGlobals = ["setTimeout","clearTimeout","setInterval","clearInterval","queueMicrotask","console","TextDecoder","TextEncoder","URL","structuredClone",
  "ReadableStream","WritableStream","TransformStream","Blob","DOMException","AbortController","MessageChannel","Response","Request","Headers","performance","atob","btoa","Event","EventTarget"];
const ctx = vm.createContext({ Zotero, Services, IOUtils, PathUtils, fetch });
const nodeOnly = new Set(["process","Buffer","global","require","module","exports","__filename","__dirname","setImmediate","clearImmediate","globalThis","window","self"]);
const jsBuiltins = new Set(vm.runInNewContext("Object.getOwnPropertyNames(globalThis)"));
for (const g of [...webGlobals, ...Object.getOwnPropertyNames(globalThis)]) {
  if (nodeOnly.has(g) || jsBuiltins.has(g) || g in ctx) continue;
  try { if (globalThis[g] !== undefined) ctx[g] = globalThis[g]; } catch {}
}
ctx.window = ctx;
vm.runInContext(fs.readFileSync("plugin/content/issue-splitter.js", "utf8"), ctx);
await ctx.ZoteroIssueSplitter.splitIssue(win, issueAtt);
console.log(log.filter((l) => !l.startsWith("debug")).join("\n---\n"));
console.log("debug lines:", log.filter((l) => l.startsWith("debug")));
console.log("attachments:", attachments.length, attachments.slice(0, 3));
