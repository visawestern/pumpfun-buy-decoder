#!/usr/bin/env node
// pumpfun_decode/run_tests.mjs — node test runner on test_vectors.json + unit checks.
// Usage: node run_tests.mjs
import { readFileSync } from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const D = require("./decode.js");
const V = JSON.parse(readFileSync(new URL("./test_vectors.json", import.meta.url)));

let pass = 0, fail = 0;
const ok = (id, cond, extra = "") => {
  if (cond) { pass++; console.log(`PASS ${id}`); }
  else { fail++; console.log(`FAIL ${id} ${extra}`); }
};

// 1. corpus vectors
for (const v of V.vectors) {
  const r = D.decodeText(v.in, "auto");
  const w = v.want || {};
  if (w.ok === false) ok(v.id + " [err]", !r.ok, `ok=${r.ok} err=${r.error}`);
  else ok(v.id + " [ok]", r.ok, `err=${r.error}`);
  for (const k of ["ix", "layout", "disc", "amount", "limit", "limitName", "track", "trailing"]) {
    if (w[k] === undefined) continue;
    const got = k === "disc" ? r.discHex : (k === "trailing" ? r.trailingHex : r[k]);
    ok(v.id + ` [${k}]`, got === w[k], `got ${got}`);
  }
  if (w.warn) ok(v.id + " [warn]", r.warnings.length > 0, "no warnings");
}

// 2. constants: buy/sell discs match sha256("global:buy"/"global:sell")[0:8] + upstream IDL
import { createHash } from "crypto";
const sighash = (s) => createHash("sha256").update("global:" + s).digest("hex").slice(0, 16);
ok("disc-buy-sighash", sighash("buy") === D.BUY_DISC_HEX, `got ${sighash("buy")}`);
ok("disc-sell-sighash", sighash("sell") === D.SELL_DISC_HEX, `got ${sighash("sell")}`);
ok("program-id", D.PROGRAM_ID === "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

// 3. base58 round-trip + hex input path
const raw = D.b58decode("AJTQ2h9DXrBj4aok4gYm2HMBsTBEaLkwH");
ok("b58-len-24", raw.length === 24, `got ${raw.length}`);
ok("b58-roundtrip", D.b58encode(raw) === "AJTQ2h9DXrBj4aok4gYm2HMBsTBEaLkwH");
const hx = D.decodeText("0x" + D.toHex(raw), "auto");
ok("hex-path", hx.ok && hx.amount === "4451588698927" && hx.inputEncoding === "hex");
ok("b58-badchar", D.parseInput("bad!input", "base58").error.includes("invalid base58"));

// 4. u64 precision (values > 2^53 must survive as strings)
const big = new Uint8Array(24);
big.set(D.BUY_DISC);
for (let i = 0; i < 8; i++) big[8 + i] = 0xff; // amount = 2^64-1
const rb = D.decodeData(big);
ok("u64-max", rb.amount === "18446744073709551615", `got ${rb.amount}`);

// 5. unknown discriminator + empty input
const unk = D.decodeText(D.b58encode(new Uint8Array(24).fill(7)), "auto");
ok("unknown-disc", !unk.ok && unk.ix === null && /unknown instruction/.test(unk.error || ""));
ok("empty", !D.decodeText("   ", "auto").ok);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
