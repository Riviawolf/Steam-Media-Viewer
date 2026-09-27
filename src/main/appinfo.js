'use strict';
// Parser for Steam's binary appcache/appinfo.vdf.
// Provides game names offline for every app in the library, not just installed ones.
//
// Layout (format 0x27/0x28/0x29):
//   magic uint32 | universe uint32 | [0x29 only] stringTableOffset int64
//   then a run of app entries, terminated by appid == 0
//   [0x29 only] string table at stringTableOffset: count uint32, then `count` NUL-terminated strings
//
// Inside an entry the payload is binary KV: a type byte, a key, then a value.
// In 0x29 keys are uint32 indexes into the string table; earlier versions inline them as strings.

const fs = require('fs');

const MAGIC_27 = 0x07564427;
const MAGIC_28 = 0x07564428;
const MAGIC_29 = 0x07564429;

const T_TABLE = 0x00;
const T_STRING = 0x01;
const T_INT32 = 0x02;
const T_FLOAT32 = 0x03;
const T_POINTER = 0x04;
const T_WIDESTRING = 0x05;
const T_COLOR = 0x06;
const T_UINT64 = 0x07;
const T_END = 0x08;
const T_INT64 = 0x0a;

function readStringTable(buf, offset) {
  let p = offset;
  const count = buf.readUInt32LE(p);
  p += 4;
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const end = buf.indexOf(0, p);
    if (end < 0) throw new Error('appinfo: unterminated string in string table');
    out[i] = buf.toString('utf8', p, end);
    p = end + 1;
  }
  return out;
}

// Walks one app's KV payload and pulls out only the wanted fields.
// Returning early is not an option, since the whole entry must be consumed to
// find the next one, but objects that are never read are skipped.
function readKeyValues(buf, start, limit, strings, want) {
  let p = start;
  const path = [];
  const found = {};

  const readCString = () => {
    const end = buf.indexOf(0, p);
    if (end < 0) throw new Error('appinfo: unterminated string');
    const s = buf.toString('utf8', p, end);
    p = end + 1;
    return s;
  };
  // Entries are wrapped in a root table called "appinfo"; callers should not
  // have to know that, so drop it when building the lookup path.
  const pathFor = (key) => {
    const parts = path.concat(key.toLowerCase());
    if (parts[0] === "appinfo") parts.shift();
    return parts.join("/");
  };
  const readKey = () => {
    if (strings) {
      const idx = buf.readUInt32LE(p);
      p += 4;
      return strings[idx] !== undefined ? strings[idx] : String(idx);
    }
    return readCString();
  };

  for (;;) {
    if (p >= limit) break;
    const type = buf.readUInt8(p);
    p += 1;

    if (type === T_END) {
      if (path.length === 0) break; // end of this app's root table
      path.pop();
      continue;
    }

    const key = readKey();

    switch (type) {
      case T_TABLE:
        path.push(key.toLowerCase());
        break;
      case T_STRING: {
        const value = readCString();
        const full = pathFor(key);
        if (want.has(full)) found[full] = value;
        break;
      }
      case T_WIDESTRING: {
        // UTF-16LE, NUL-terminated. Rare, but must be consumed correctly.
        let end = p;
        while (end + 1 < buf.length && !(buf[end] === 0 && buf[end + 1] === 0)) end += 2;
        const value = buf.toString('utf16le', p, end);
        p = end + 2;
        const full = pathFor(key);
        if (want.has(full)) found[full] = value;
        break;
      }
      case T_INT32:
      case T_COLOR:
      case T_POINTER: {
        const value = buf.readInt32LE(p);
        p += 4;
        const full = pathFor(key);
        if (want.has(full)) found[full] = value;
        break;
      }
      case T_FLOAT32:
        p += 4;
        break;
      case T_UINT64:
      case T_INT64:
        p += 8;
        break;
      default:
        throw new Error(`appinfo: unknown value type 0x${type.toString(16)} at ${p - 1}`);
    }
  }
  return { found, end: p };
}

/**
 * @returns {Map<string, {name: string, type: string}>} keyed by app id as a string
 */
function parseAppInfo(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 16) throw new Error('appinfo: file too short');

  const magic = buf.readUInt32LE(0);
  if (magic !== MAGIC_27 && magic !== MAGIC_28 && magic !== MAGIC_29) {
    throw new Error(`appinfo: unrecognised magic 0x${magic.toString(16)}`);
  }

  let p = 8; // past magic + universe
  let strings = null;
  if (magic === MAGIC_29) {
    const stringTableOffset = Number(buf.readBigUInt64LE(8));
    p = 16;
    strings = readStringTable(buf, stringTableOffset);
  }

  // sha1 of the binary vdf was added in 0x28
  const hasBinaryVdfSha = magic === MAGIC_28 || magic === MAGIC_29;
  const want = new Set(['common/name', 'common/type', 'common/sortas']);
  const apps = new Map();

  for (;;) {
    if (p + 4 > buf.length) break;
    const appId = buf.readUInt32LE(p);
    p += 4;
    if (appId === 0) break; // terminator

    if (p + 4 > buf.length) break;
    const size = buf.readUInt32LE(p);
    p += 4;
    const entryEnd = p + size;

    // Fixed header before the KV payload.
    let q = p + 4 /*infoState*/ + 4 /*lastUpdated*/ + 8 /*picsToken*/ + 20 /*textVdfSha1*/ + 4 /*changeNumber*/;
    if (hasBinaryVdfSha) q += 20;

    if (q < buf.length && entryEnd <= buf.length) {
      try {
        const { found } = readKeyValues(buf, q, Math.min(entryEnd, buf.length), strings, want);
        const name = found['common/name'];
        if (name) {
          apps.set(String(appId), {
            name,
            type: String(found['common/type'] || '').toLowerCase(),
            sortAs: found['common/sortas'] || null,
          });
        }
      } catch {
        // A single malformed entry should not sink the whole cache.
      }
    }

    p = entryEnd; // `size` is authoritative - always resync from it
  }

  return apps;
}

module.exports = { parseAppInfo };
