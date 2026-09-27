'use strict';
// Minimal parser for Steam's *text* VDF/KeyValues files (appmanifest_*.acf,
// localconfig.vdf, libraryfolders.vdf). Only what is needed: quoted keys,
// quoted values, nested braces, and // comments.

const TOKEN = /"((?:[^"\\]|\\.)*)"\s*(?:"((?:[^"\\]|\\.)*)")?|\{|\}|\/\/[^\n]*/g;

function unescapeVdf(s) {
  return s.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
}

function parseTextVdf(text) {
  const root = {};
  const stack = [root];
  let pendingKey = null;
  let m;

  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(text)) !== null) {
    const tok = m[0];
    if (tok.startsWith('//')) continue;

    if (tok === '{') {
      const obj = {};
      if (pendingKey !== null) {
        stack[stack.length - 1][pendingKey] = obj;
        pendingKey = null;
      }
      stack.push(obj);
      continue;
    }
    if (tok === '}') {
      if (stack.length > 1) stack.pop();
      continue;
    }

    const key = unescapeVdf(m[1]);
    if (m[2] !== undefined) {
      stack[stack.length - 1][key] = unescapeVdf(m[2]);
      pendingKey = null;
    } else {
      pendingKey = key; // a block should follow
    }
  }
  return root;
}

// Case-insensitive nested lookup, since Steam's own casing is inconsistent
// between files and between client versions.
function vdfGet(obj, ...path) {
  let cur = obj;
  for (const seg of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    const key = Object.keys(cur).find((k) => k.toLowerCase() === String(seg).toLowerCase());
    if (key === undefined) return undefined;
    cur = cur[key];
  }
  return cur;
}

module.exports = { parseTextVdf, vdfGet };
