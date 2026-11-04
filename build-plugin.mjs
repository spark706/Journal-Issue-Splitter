// Bundle the plugin script and package plugin/ as an .xpi (zip).
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
await build({
  entryPoints: ["src/zotero-plugin.js"],
  bundle: true, format: "iife", target: "firefox115", platform: "browser",
  outfile: "plugin/content/issue-splitter.js", legalComments: "none", minify: true,
  logLevel: "warning",
});
const version = JSON.parse(fs.readFileSync("plugin/manifest.json")).version;
fs.mkdirSync("dist", { recursive: true });
const xpi = path.resolve(`dist/journal-issue-splitter-${version}.xpi`);
fs.rmSync(xpi, { force: true });
execFileSync("zip", ["-r", "-q", xpi, "."], { cwd: "plugin" });
console.log(`Built ${xpi} (${(fs.statSync(xpi).size / 1e6).toFixed(1)} MB)`);
