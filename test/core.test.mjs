import test from "node:test";
import assert from "node:assert/strict";
import { analyzeIssue, applyKnownPageRanges, cleanDoi, doiFileName } from "../src/core.js";
import { compareWithCrossref, fetchIssueFromCrossref } from "../src/crossref.js";

const cover = "NOVEMBER 2018 VOLUME 9 NUMBER 6 ITSGBQ (ISSN 1949-3053)\nA Paper . . . . . . . A. Author 100\nB Paper . . . . . B. Author 104\nC Paper . . . . C. Author 108\nDigital Object Identifier 10.1109/TSG.2018.1";
const p = (n, doi) => `${n} IEEE TRANSACTIONS ON SMART GRID, VOL. 9, NO. 6, NOVEMBER 2018\nTitle\nManuscript received May 1.\nDigital Object Identifier ${doi}\nbody`;
const body = (n, extra = "") => `IEEE TRANSACTIONS ON SMART GRID, VOL. 9, NO. 6, NOVEMBER 2018 ${n}\ntext ${extra}`;

test("finds papers, ranges, other items, issue info", () => {
  const pages = [cover, p(100, "10.1109/TSG.2017.11"), body(101, "[3] doi: 10.1109/TSG.2016.9."), body(102), body(103),
    p(104, "10.1109/TSG.2017.22"), body(105), body(106), body(107),
    "Information for Authors\nDigital Object Identifier 10.1109/TSG.2018.2"];
  const a = analyzeIssue(pages);
  assert.equal(a.info.issn, "1949-3053");
  assert.equal(a.info.volume, "9"); assert.equal(a.info.number, "6"); assert.equal(a.info.year, "2018");
  assert.equal(a.info.journal, "IEEE TRANSACTIONS ON SMART GRID");
  assert.deepEqual(a.papers.map((x) => [x.doi, x.startPage, x.endPage, x.printedStartPage]),
    [["10.1109/TSG.2017.11", 1, 4, 100], ["10.1109/TSG.2017.22", 5, 8, 104]]);
  assert.deepEqual(a.other.map((x) => x.doi), ["10.1109/TSG.2018.1", "10.1109/TSG.2018.2"]);
  assert.equal(a.tocCount, 3);
  assert.deepEqual(a.tocMissing, [108]);
  assert.ok(a.warnings.some((w) => /3 entries but 2 papers/.test(w)));
});

test("reference DOIs without the footnote phrase are ignored", () => {
  const a = analyzeIssue(["doi: 10.1109/TSG.2016.2545113.", "see 10.1109/TPWRD.2016.1"]);
  assert.equal(a.papers.length + a.other.length, 0);
  assert.ok(a.warnings[0].includes("No 'Digital Object Identifier'"));
});

test("cleanDoi strips trailing punctuation; file names are Windows-safe", () => {
  assert.equal(cleanDoi("10.1109/TSG.2016.2545113."), "10.1109/TSG.2016.2545113");
  assert.equal(doiFileName("10.1109/TSG.2017.1"), "10.1109_TSG.2017.1.pdf");
  assert.equal(doiFileName("10.1002/(SICI)1:2<3>"), "10.1002_(SICI)1_2_3_.pdf");
});

test("known page ranges trim trailing pages", () => {
  const papers = [{ doi: "10.1/A", startPage: 5, endPage: 20 }];
  applyKnownPageRanges(papers, new Map([["10.1/a", "5482-5493"]]));
  assert.equal(papers[0].endPage, 16);
});

test("Crossref fetch filters by volume/issue and paginates; compare finds gaps", async () => {
  const calls = [];
  const fake = async (url) => {
    calls.push(url);
    const first = url.includes("cursor=*");
    return { ok: true, json: async () => ({ message: {
      "next-cursor": first ? "abc" : "abc",
      items: first ? [
        { DOI: "10.1109/tsg.2017.11", title: ["A"], volume: "9", issue: "6", page: "100-103" },
        { DOI: "10.1109/tsg.2017.99", title: ["Other issue"], volume: "9", issue: "5", page: "1-2" },
      ] : [{ DOI: "10.1109/tsg.2017.33", title: ["C"], volume: "9", issue: "6", page: "108-110" }],
    } }) };
  };
  const cr = await fetchIssueFromCrossref({ issn: "1949-3053", volume: "9", number: "6", year: "2018" }, fake);
  assert.deepEqual(cr.map((c) => c.doi), ["10.1109/tsg.2017.11", "10.1109/tsg.2017.33"]);
  assert.ok(calls[0].includes("/journals/1949-3053/works") && calls[0].includes("from-pub-date:2016-01-01"));
  const cmp = compareWithCrossref({ papers: [{ doi: "10.1109/TSG.2017.11" }, { doi: "10.1109/TSG.2017.22" }], other: [] }, cr);
  assert.deepEqual(cmp.missingFromPdf.map((c) => c.doi), ["10.1109/tsg.2017.33"]);
  assert.deepEqual(cmp.notInCrossref.map((c) => c.doi), ["10.1109/TSG.2017.22"]);
});
