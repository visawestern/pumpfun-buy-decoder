# pumpfun_decode — version-tolerant pump.fun `buy` decoder (SSE Q23730, round 578)

**Question essence (Solana StackExchange Q23730, JrM Lackar, 2025-11-10,
https://solana.stackexchange.com/questions/23730/cant-decode-pumpfun-buy-ix —
score 0, answers 0, 93 views):**
a recent `buy` ix args (`AJTQ2h9DXrBj4aok4gYm2HMBsTBEaLkwH`, visible on Solscan
in tx `3wTzXpYUyqfgW4bhyzE6Vk9qGbn8uVMrqwERngv4XsrMyTA8rZUua5xqbNPqaTSs6EGf868NZkgER1MUSqs7Ub9S`)
is 24 bytes (8 discriminator + u64 + u64, no `track_volume`), but the strict
`anchor.BorshCoder(onchain IDL)` expects a `track_volume` suffix and throws
`offset out of range ... Received 16`. Solscan, with the same on-chain IDL,
decodes it fine. Asked: is this the right way to decode, what is missed.

**Answer built in:** two compounding causes —
(a) the 24-byte buffer is the R1 legacy revision (pre-`track_volume`); a strict
coder built from the current IDL reads the suffix past the end and throws —
Solscan works because it pins an older revision / falls back by length;
(b) the snippet double-handles encoding (`bs58.decode` by hand **plus**
`'base58'` passed to `coder.instruction.decode`), and the reported
`<=15 / Received 16` window points at a 16-byte buffer reaching the failing
read — shorter than the pasted 24-byte args — consistent with such a
double-handling (or a truncated slice) upstream of the coder.
The page below removes both failure modes: one input form, layout picked by
(discriminator, length, tag bytes), unknown tails kept raw.

## Discriminator / program versions (verified 2026-09-28)

- Program `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` — address never changed;
  versioning is **IDL-level**, not address-level.
- `buy` disc `66063d1201daebea` = `sha256("global:buy")[0:8]` (recomputed locally);
  `sell` disc `33e685a4017f83ad` (decoded as a hint only).
- Revisions of `buy` args: **R1** legacy 24 B (`amount`, `max_sol_cost`);
  **R2** +`track_volume: Option<bool>` 25/26 B (tag + optional value);
  **R3** +`track_volume: OptionBool{bool}` 25 B (current upstream
  `pump-fun/pump-public-docs` `idl/pump.json`: OptionBool is a struct of one
  bool, always exactly 1 byte — verified via raw IDL fetch; `sell` there is
  `amount` + `min_sol_output`, no track field).
- Genuine ambiguity: 25 B ending `0x00` = R2 None **or** R3 false (identical
  bytes) → reported as `ambiguous-25B` with both readings, never guessed.

## Files (all inside `pumpfun_decode/`, nothing else touched)

| File | What |
|---|---|
| `index.html` | UI: paste base58/hex → layout pill + fields + raw + warnings; revision table; throw-explainer; offline self-test. No CDN, no requests. |
| `decode.js` | Pure logic (browser + node): own base58/hex, u64-LE via BigInt, length/tag-switched tolerant decode. |
| `test_vectors.json` | 11 vectors: real Q23730 legacy + synthetic R1/R2/R3/tail/badtag/sell/truncated/garbage. |
| `run_tests.mjs` | Node runner (`node run_tests.mjs`): vectors + sighash/disc/program constants + round-trip/hex/u64-max/unknown-disc/empty. |
| `README.md` | This file. |

## Run locally (no publish)

```sh
cd pumpfun_decode
python3 -m http.server 8138
# open http://localhost:8138/index.html
node run_tests.mjs
```

## Test report (2026-09-28, round 578)

- `node run_tests.mjs`: **71/71 passed** (incl. Q23730 vector →
  `legacy-24B`, amount `4451588698927`, max_sol_cost `495000001`).
- `curl http://localhost:8138/index.html` / `decode.js` / `test_vectors.json`:
  **HTTP 200** all; page bundle greps clean for `https?://`, `cdn`,
  `fetch(`, `XMLHttpRequest`, `<link`, `src=http`, `@import` — verified offline-static.
- Checkers: `check_balances.py` → see below; `check_solana.py` → NOT_YET (logged).

## Scope honesty

- Decodes instruction **data** for `buy` (plus `sell` hint). Not a tx-indexer:
  no account parsing, no RPC, no event/CPI decoding — those need a live pipeline.
- `ambiguous-25B` (None-vs-false) is undecidable from bytes alone by construction;
  the page says so instead of picking.
- The `<=15 / Received 16` double-handling analysis is an inference from the
  reported numbers (marked as such on the page), not a reproduction — the exact
  anchor-version `decode()` path was not re-executed.
