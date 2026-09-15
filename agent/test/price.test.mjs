import assert from "node:assert/strict";
import test from "node:test";
import { extractPrice, marketStatusEt, parseSellers } from "../price.mjs";

test("extractPrice reads common quote payload shapes", () => {
  assert.equal(extractPrice({ price: 187.42 }), 187.42);
  assert.equal(extractPrice({ data: { regularMarketPrice: "$218.36" } }), 218.36);
  assert.equal(extractPrice({ quote: { price: 200 } }), 200);
  assert.equal(extractPrice({ data: { c: 123.45 } }), 123.45);
  assert.equal(extractPrice({ price: "1,234.5" }), 1234.5);
  assert.equal(extractPrice({ nope: true }), null);
  assert.equal(extractPrice({ price: -5 }), null);
});

test("parseSellers splits env lists and falls back to defaults", () => {
  assert.deepEqual(parseSellers("https://a.example, https://b.example"), [
    "https://a.example",
    "https://b.example",
  ]);
  assert.equal(parseSellers("").length, 3);
  assert.equal(parseSellers("https://only.example").length, 1);
});

test("marketStatusEt maps US/Eastern sessions", () => {
  assert.equal(marketStatusEt(new Date("2026-01-14T12:00:00Z")), 1); // Wed 07:00 ET pre-market
  assert.equal(marketStatusEt(new Date("2026-01-14T14:30:00Z")), 2); // Wed 09:30 ET open
  assert.equal(marketStatusEt(new Date("2026-01-14T22:00:00Z")), 3); // Wed 17:00 ET post
  assert.equal(marketStatusEt(new Date("2026-01-15T03:00:00Z")), 4); // Wed 22:00 ET overnight
  assert.equal(marketStatusEt(new Date("2026-01-16T21:00:00Z")), 3); // Fri 16:00 ET post
  assert.equal(marketStatusEt(new Date("2026-01-17T01:30:00Z")), 5); // Fri 20:30 ET closed
  assert.equal(marketStatusEt(new Date("2026-01-17T15:00:00Z")), 5); // Saturday
  assert.equal(marketStatusEt(new Date("2026-01-18T15:00:00Z")), 5); // Sunday before 20:00 ET
});
