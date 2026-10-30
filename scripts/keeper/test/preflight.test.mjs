import test from "node:test";
import assert from "node:assert/strict";
import { FATAL_CHECKS, formatReport, marketIdOf } from "../preflight.mjs";

const LOAN = `0x${"aa".repeat(20)}`;
const COLLATERAL = `0x${"bb".repeat(20)}`;
const ORACLE = `0x${"cc".repeat(20)}`;
const IRM = `0x${"dd".repeat(20)}`;
const LLTV = 625_000_000_000_000_000n;

function params(lltv = LLTV) {
  return {
    loanToken: LOAN,
    collateralToken: COLLATERAL,
    oracle: ORACLE,
    irm: IRM,
    lltv,
  };
}

test("marketIdOf: returns a 32-byte hex id", () => {
  const id = marketIdOf(params());

  assert.match(id, /^0x[0-9a-f]{64}$/);
});

test("marketIdOf: deterministic and sensitive to LLTV", () => {
  const id = marketIdOf(params());
  const again = marketIdOf(params());
  const otherLltv = marketIdOf(params(LLTV + 1n));

  assert.equal(again, id);
  assert.notEqual(otherLltv, id);
});

test("formatReport: failed fatal check reports FAIL, the check name, and Blocking", () => {
  const report = formatReport({
    ok: false,
    fatal: true,
    checks: [
      { name: "rpc-chain-id", ok: true, detail: "chain 4663" },
      { name: "books-initialized", ok: false, detail: "not initialized: bookA" },
    ],
  });

  assert.match(report, /preflight: FAIL/);
  assert.match(report, /books-initialized/);
  assert.match(report, /Blocking: books-initialized/);
});

test("FATAL_CHECKS: covers books and market params", () => {
  assert.ok(FATAL_CHECKS.includes("books-initialized"));
  assert.ok(FATAL_CHECKS.includes("market-params"));
});
