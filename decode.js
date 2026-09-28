/* pumpfun_decode/decode.js — version-tolerant pump.fun buy decoder (no DOM, no network).
 * Works in browser (window.PumpDecode) and in node (module.exports).
 *
 * Background (SSE Q23730, 2025-11-10): a 24-byte legacy `buy` args buffer
 * (8 discriminator + u64 amount + u64 max_sol_cost, no track_volume field)
 * throws under a strict BorshCoder built from the then-current on-chain IDL,
 * which expects a track_volume suffix. Solscan decoded the same bytes fine
 * (older pinned IDL revision / lenient fallback).
 *
 * IDL revisions of `buy` (program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P,
 * address never changed — versioning is IDL-level):
 *   R1 legacy : disc + amount:u64 + max_sol_cost:u64                       = 24 B
 *   R2 option : disc + amount + max_sol_cost + track: Option<bool>         = 25 B (None) / 26 B (Some)
 *     (Option<bool> borsh: 1 tag byte 0x00=None | 0x01=Some, then value byte if Some)
 *   R3 struct : disc + amount + max_sol_cost + track: OptionBool{bool}     = 25 B
 *     (current upstream pump-public-docs idl/pump.json: OptionBool is a
 *      struct wrapping one bool, NOT an option — always exactly 1 byte)
 *
 * Strategy: switch on (discriminator, total length, tag bytes) instead of one
 * strict layout; always show known u64 fields + raw hex + trailing bytes, so
 * unknown future revisions still decode tolerantly instead of throwing.
 */
(function (root) {
  "use strict";

  var PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
  var BUY_DISC = [102, 6, 61, 18, 1, 218, 235, 234];
  var BUY_DISC_HEX = "66063d1201daebea";
  var SELL_DISC = [51, 230, 133, 164, 1, 127, 131, 173];
  var SELL_DISC_HEX = "33e685a4017f83ad";

  var B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  function b58decode(s) {
    var str = String(s).trim();
    if (!str) throw new Error("empty input");
    var zeroes = 0;
    while (zeroes < str.length && str[zeroes] === "1") zeroes++;
    var num = 0n, mult = 1n;
    for (var i = str.length - 1; i >= 0; i--) {
      var d = B58.indexOf(str[i]);
      if (d < 0) throw new Error("invalid base58 character " + JSON.stringify(str[i]));
      num += BigInt(d) * mult;
      mult *= 58n;
    }
    var hex = num.toString(16);
    if (hex.length % 2) hex = "0" + hex;
    var body = hex === "00" || num === 0n ? [] : hex.match(/../g).map(function (h) { return parseInt(h, 16); });
    var out = new Array(zeroes).fill(0).concat(body);
    return Uint8Array.from(out);
  }

  function b58encode(bytes) {
    var b = Array.from(bytes);
    var zeroes = 0;
    while (zeroes < b.length && b[zeroes] === 0) zeroes++;
    var num = 0n;
    for (var i = 0; i < b.length; i++) num = num * 256n + BigInt(b[i]);
    var s = "";
    while (num > 0n) { s = B58[Number(num % 58n)] + s; num = num / 58n; }
    for (var k = 0; k < zeroes; k++) s = "1" + s;
    return s || "1";
  }

  function hexDecode(s) {
    var h = String(s).trim().replace(/^0x/i, "").replace(/\s+/g, "");
    if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2 !== 0 || h.length === 0)
      throw new Error("invalid hex (need even-length [0-9a-f])");
    var out = new Uint8Array(h.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }

  function toHex(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) {
      var h = bytes[i].toString(16);
      s += (h.length < 2 ? "0" : "") + h;
    }
    return s;
  }

  function readU64LE(b, o) {
    var v = 0n;
    for (var i = 7; i >= 0; i--) v = v * 256n + BigInt(b[o + i]);
    return v;
  }

  function sameDisc(bytes, disc) {
    if (bytes.length < 8) return false;
    for (var i = 0; i < 8; i++) if (bytes[i] !== disc[i]) return false;
    return true;
  }

  // Parse one input string -> {bytes} or {error}. mode: "auto"|"base58"|"hex".
  // Auto: 0x-prefix or "hex:"-prefix forces hex; else base58, with hex retry.
  function parseInput(text, mode) {
    var s = String(text == null ? "" : text).trim();
    if (!s) return { error: "empty input — paste base58 (or hex) buy args" };
    var m = mode || "auto";
    var cleaned = s.replace(/\s+/g, "");
    if (m === "hex" || (m === "auto" && (/^0x/i.test(cleaned) || /^hex:/i.test(cleaned)))) {
      try { return { bytes: hexDecode(cleaned.replace(/^hex:/i, "")), encoding: "hex" }; }
      catch (e) { return { error: e.message }; }
    }
    try { return { bytes: b58decode(cleaned), encoding: "base58" }; }
    catch (e1) {
      if (m === "base58") return { error: e1.message };
      try { return { bytes: hexDecode(cleaned), encoding: "hex", note: "parsed as hex (base58 failed)" }; }
      catch (e2) { return { error: e1.message + "; not hex either (" + e2.message + ")" }; }
    }
  }

  // Version-tolerant decode of one instruction-data buffer.
  // Never throws for well-formed buffers; always returns known fields + raw.
  function decodeData(bytes) {
    var b = bytes;
    var res = {
      ok: false,
      bytesLen: b.length,
      bytesHex: toHex(b),
      discHex: b.length >= 8 ? toHex(b.slice(0, 8)) : (b.length ? toHex(b) : ""),
      ix: null,               // "buy" | "sell" | null
      amount: null,           // decimal string
      limitName: null,        // "max_sol_cost" | "min_sol_output"
      limit: null,            // decimal string
      track: null,            // "absent"|"none"|"true"|"false"|"ambiguous-none-or-false"|"invalid"|null
      trackDetail: "",
      layout: null,
      trailingHex: "",
      warnings: [],
      error: null
    };

    if (b.length < 8) {
      res.error = "truncated: " + b.length + " byte(s), need at least 8 for the discriminator";
      return res;
    }

    var isBuy = sameDisc(b, BUY_DISC);
    var isSell = sameDisc(b, SELL_DISC);
    if (!isBuy && !isSell) {
      res.error = "unknown instruction: discriminator " + res.discHex +
        " is not buy (" + BUY_DISC_HEX + ") nor sell (" + SELL_DISC_HEX + ")";
      res.warnings.push("Wrong ix? buy_v2 / sell_v2 and other pump instructions use different discriminators (out of scope).");
      return res;
    }
    res.ix = isBuy ? "buy" : "sell";
    res.limitName = isBuy ? "max_sol_cost" : "min_sol_output";

    if (b.length < 24) {
      // Short buffer: show whatever u64 prefix is complete. This bucket also
      // catches the Q23730 failure class where the coder received fewer bytes
      // than the pasted args (e.g. encoding double-handling upstream).
      if (b.length >= 16) {
        res.amount = readU64LE(b, 8).toString();
        res.warnings.push("amount decoded, but the second u64 is cut off.");
      } else {
        res.warnings.push("fewer than 16 bytes: not even `amount` is complete.");
      }
      res.error = "truncated " + res.ix + ": " + b.length + " byte(s), need 24 for the two u64 fields";
      res.warnings.push("If you pasted full args, check for encoding double-handling: " +
        "either hand the coder raw bytes OR a base58 string — never an already-decoded " +
        "buffer together with a 'base58' flag.");
      res.layout = "truncated";
      return res;
    }

    res.amount = readU64LE(b, 8).toString();
    res.limit = readU64LE(b, 16).toString();

    if (!isBuy) {
      // sell: amount + min_sol_output, no track field in any known revision.
      if (b.length === 24) { res.ok = true; res.layout = "sell-24B"; res.track = "absent"; res.trackDetail = "sell has no track_volume field"; }
      else {
        res.ok = true; res.layout = "tolerant-trailing";
        res.trailingHex = toHex(b.slice(24));
        res.track = "absent";
        res.warnings.push("sell with " + (b.length - 24) + " trailing byte(s): newer revision? Known u64s above, raw tail below.");
      }
      return res;
    }

    // ---- buy ----
    var rest = b.slice(24);
    if (rest.length === 0) {
      res.ok = true; res.layout = "legacy-24B";
      res.track = "absent";
      res.trackDetail = "R1 legacy: no track_volume field (this is the Q23730 case)";
      res.warnings.push("Legacy 24-byte layout: decodes with the pre-track_volume IDL revision; " +
        "a strict coder built from the current IDL throws here — that is the Q23730 error, not corrupt data.");
      return res;
    }
    if (rest.length === 1) {
      if (rest[0] === 0x00) {
        // Genuinely ambiguous across revisions: R2 None tag vs R3 struct false.
        res.ok = true; res.layout = "ambiguous-25B";
        res.track = "ambiguous-none-or-false";
        res.trackDetail = "0x00 reads as R2 Option<bool>=None OR R3 OptionBool=false — identical bytes, pick by IDL revision";
        res.warnings.push("Ambiguous trailing 0x00: None under the Option<bool> revision, false under the OptionBool-struct revision. u64s are unaffected.");
      } else if (rest[0] === 0x01) {
        res.ok = true; res.layout = "struct-bool-25B";
        res.track = "true";
        res.trackDetail = "R3 OptionBool=true (R2 Option<bool> reading is impossible: Some needs 2 bytes)";
      } else {
        res.ok = false; res.layout = "tolerant-badtag";
        res.track = "invalid";
        res.trackDetail = "trailing byte 0x" + rest[0].toString(16) + " is neither a valid Option tag (0x00/0x01) nor a valid bool (0x00/0x01 as struct)";
        res.error = "invalid track_volume byte with no valid reading under R2 or R3";
        res.trailingHex = toHex(rest);
      }
      return res;
    }
    if (rest.length === 2) {
      if (rest[0] === 0x01 && (rest[1] === 0x00 || rest[1] === 0x01)) {
        res.ok = true; res.layout = "option-some-26B";
        res.track = rest[1] === 0x01 ? "true" : "false";
        res.trackDetail = "R2 Option<bool>=Some(" + res.track + ")" +
          (rest[1] === 0x01 ? "; alternative R3 reading: OptionBool=true + 1 trailing 0x01 byte" : "; alternative R3 reading: OptionBool=true + 1 trailing 0x00 byte (struct byte is 0x01=true, tail is the second byte)");
        if (rest[1] === 0x00) res.warnings.push("Note the R3 alternative reading (struct true + trailing 0x00) — u64s identical either way.");
      } else if (rest[0] === 0x00) {
        res.ok = true; res.layout = "tolerant-trailing";
        res.track = "none";
        res.trackDetail = "R2 Option<bool>=None, plus 1 trailing byte (or R3 OptionBool=false + 1 trailing byte)";
        res.trailingHex = toHex(rest.slice(1));
        res.warnings.push("None + 1 trailing byte: unknown revision appended data? Known fields above, raw tail below.");
      } else {
        res.ok = false; res.layout = "tolerant-badtag";
        res.track = "invalid";
        res.trackDetail = "tag byte 0x" + rest[0].toString(16) + " invalid under R2 and R3";
        res.error = "invalid track_volume tag byte";
        res.trailingHex = toHex(rest);
      }
      return res;
    }
    // rest.length >= 3: unknown newer revision — prefix-decode, keep the tail raw.
    res.ok = true; res.layout = "tolerant-trailing";
    if (rest[0] === 0x01 && (rest[1] === 0x00 || rest[1] === 0x01)) {
      res.track = rest[1] === 0x01 ? "true" : "false";
      res.trackDetail = "R2 Option<bool>=Some(" + res.track + ") prefix; bytes after offset 26 are unknown-revision tail";
      res.trailingHex = toHex(rest.slice(2));
    } else if (rest[0] === 0x00) {
      res.track = "none";
      res.trackDetail = "R2 Option<bool>=None prefix (or R3 false); bytes after offset 25 are unknown-revision tail";
      res.trailingHex = toHex(rest.slice(1));
    } else if (rest[0] === 0x01 || rest[0] === 0x00) {
      res.track = "invalid";
      res.trackDetail = "prefix not a clean R2/R3 value; full tail kept raw";
      res.trailingHex = toHex(rest);
    } else {
      res.track = "invalid";
      res.trackDetail = "tag byte 0x" + rest[0].toString(16) + " invalid under R2 and R3; full tail kept raw";
      res.trailingHex = toHex(rest);
    }
    res.warnings.push((b.length - 24) + " byte(s) after the two u64s: longer than any known buy layout (max 26). " +
      "Possibly a newer IDL revision — known fields above, raw tail below.");
    return res;
  }

  function decodeText(text, mode) {
    var p = parseInput(text, mode);
    if (p.error) {
      return { ok: false, bytesLen: 0, bytesHex: "", discHex: "", ix: null, amount: null, limitName: null, limit: null, track: null, trackDetail: "", layout: null, trailingHex: "", warnings: [], error: p.error };
    }
    var r = decodeData(p.bytes);
    if (p.note) r.warnings.unshift(p.note);
    r.inputEncoding = p.encoding;
    return r;
  }

  var api = {
    PROGRAM_ID: PROGRAM_ID,
    BUY_DISC: BUY_DISC,
    BUY_DISC_HEX: BUY_DISC_HEX,
    SELL_DISC: SELL_DISC,
    SELL_DISC_HEX: SELL_DISC_HEX,
    b58decode: b58decode,
    b58encode: b58encode,
    hexDecode: hexDecode,
    toHex: toHex,
    readU64LE: readU64LE,
    parseInput: parseInput,
    decodeData: decodeData,
    decodeText: decodeText
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PumpDecode = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
