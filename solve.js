// Fast drop-in replacement for makefun-site 1.0.0's build(input).
// Written fresh from the makefun-site README and its reference semantics:
// same front matter, template dialect, Markdown subset, slug rule and report,
// byte for byte. Dependency-free ES module; run(input) returns the output tree.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const RESERVED = ['posts', 'tags', 'page'];
const SLUG_MAX = 64;

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const escChar = (c) => ESCAPES[c];
/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return text.replace(ESC_RE, escChar);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

const MARK_RE = /\p{M}/gu;
const slugCache = new Map();
/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), and "untitled" when nothing is left.
 * Results are cached: tag and heading texts repeat across a site.
 */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain.charCodeAt(i);
    let keep = 0;
    if (ch >= 65 && ch <= 90) keep = ch + 32;
    else if ((ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57)) keep = ch;
    if (keep === 0) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = 2;
  let out = `${slug}-2`;
  while (taken.has(out)) out = `${slug}-${++n}`;
  taken.add(out);
  return out;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return DAYS_IN_MONTH[m - 1];
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function stripTrailing(line) {
  let e = line.length;
  while (e > 0) {
    const c = line.charCodeAt(e - 1);
    if (c !== 32 && c !== 9) break;
    e--;
  }
  return e === line.length ? line : line.slice(0, e);
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function isValidDate(raw) {
  if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return false;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = raw.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  const y = +raw.slice(0, 4);
  const m = +raw.slice(5, 7);
  const d = +raw.slice(8, 10);
  return y >= 1970 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
}

function isTemplateName(raw) {
  if (raw.length === 0) return false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

function isSlugValue(raw) {
  if (raw.length === 0 || raw.length > 64) return false;
  let prevDash = true;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 45) {
      if (prevDash) return false;
      prevDash = true;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
    else return false;
  }
  return !prevDash;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return s.error !== undefined ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date':
      return isValidDate(raw)
        ? { value: raw }
        : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    case 'tags': {
      if (raw.length < 2 || raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isTemplateName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlugValue(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  // The closing "---" is found first: a source whose front matter is not
  // closed is refused for that, whatever its lines hold.
  let pos = 4; // just past the opening "---\n"
  let closePos = -1;
  let bodyStart = -1;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    if (text.slice(pos, lineEnd) === '---') {
      closePos = pos;
      bodyStart = nl === -1 ? text.length : nl + 1;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (closePos === -1) return { error: 'the front matter is not closed' };
  const data = {};
  pos = 4;
  let lineNo = 2; // the next line's number (the opening "---" is line 1)
  while (pos < closePos) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(pos, lineEnd);
    if (!isBlankLine(line) && line.charCodeAt(0) !== 35) {
      // "key: value": a key of a-z and "_", a colon, one space and the value.
      let j = 0;
      const L = line.length;
      while (j < L) {
        const c = line.charCodeAt(j);
        if ((c >= 97 && c <= 122) || c === 95) j++;
        else break;
      }
      if (j === 0 || j >= L || line.charCodeAt(j) !== 58) return { error: `line ${lineNo} is not "key: value"` };
      const key = line.slice(0, j);
      let raw;
      if (j + 1 === L) raw = '';
      else if (line.charCodeAt(j + 1) === 32) raw = stripTrailing(line.slice(j + 2));
      else return { error: `line ${lineNo} is not "key: value"` };
      if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if (v.error !== undefined) return v;
      data[key] = v.value;
    }
    if (nl === -1) break;
    pos = nl + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const WS_RE = /\s/;

/** Whether the code unit is whitespace (the \s class, for single characters). */
function isWSCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** Whether `line` closes a fence. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` continues a list item (two or more spaces, then a non-space). */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i >= line.length) return false;
  return !isWSCode(line.charCodeAt(i));
}

// One line's block kind, computed in a single scan; the payloads land in the
// CL_* scratch variables (renderMarkdown reads them before classifying again).
// 0 blank, 1 fence, 2 heading, 3 thematic break, 4 blockquote, 5 bullet,
// 6 ordered list, 7 plain (paragraph text).
let CL_lang = '';
let CL_depth = 0;
let CL_text = '';
let CL_num = 0;

function classifyLine(line) {
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9 || line.length === 0) {
    // Blank, or indented: indented lines are never a block opener.
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) return 7;
    }
    return 0;
  }
  if (c0 === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96) {
    let i = 3;
    while (i < line.length && isLangChar(line.charCodeAt(i))) i++;
    CL_lang = line.slice(3, i);
    while (i < line.length) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) return 7;
      i++;
    }
    return 1;
  }
  if (c0 === 35) {
    let n = 0;
    while (n < line.length && line.charCodeAt(n) === 35) n++;
    if (n <= 6) {
      let i = n;
      if (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) {
        while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
        let e = line.length;
        while (e > i && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
        if (e > i) {
          CL_depth = n;
          CL_text = line.slice(i, e);
          return 2;
        }
      }
    }
    return 7;
  }
  if ((c0 === 45 && line.charCodeAt(1) === 45 && line.charCodeAt(2) === 45) ||
    (c0 === 42 && line.charCodeAt(1) === 42 && line.charCodeAt(2) === 42)) {
    for (let i = 3; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) return 7;
    }
    return 3;
  }
  if (c0 === 62) return 4;
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) {
    CL_text = line.slice(2);
    return 5;
  }
  if (c0 >= 48 && c0 <= 57) {
    let i = 0;
    let num = 0;
    let digits = 0;
    while (i < line.length && digits < 9) {
      const c = line.charCodeAt(i);
      if (c < 48 || c > 57) break;
      num = num * 10 + (c - 48);
      i++;
      digits++;
    }
    if (digits > 0 && line.charCodeAt(i) === 46 && line.charCodeAt(i + 1) === 32) {
      CL_num = num;
      CL_text = line.slice(i + 2);
      return 6;
    }
  }
  return 7;
}

/**
 * The first index from `from` where `s` holds `what` ("**" or "]") outside a
 * backslash escape, or -1. A match is escaped when an odd run of backslashes
 * stands right before it (pairing restarts at `from`, as in the reference scan).
 */
function findUnescaped(s, what, from) {
  let k = s.indexOf(what, from);
  while (k !== -1) {
    let b = 0;
    for (let p = k - 1; p >= from && s.charCodeAt(p) === 92; p--) b++;
    if (b % 2 === 0) return k;
    k = s.indexOf(what, k + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let k = s.indexOf('*', from);
  while (k !== -1) {
    let b = 0;
    for (let p = k - 1; p >= from && s.charCodeAt(p) === 92; p--) b++;
    if (b % 2 === 1) {
      k = s.indexOf('*', k + 1);
      continue;
    }
    if (s.charCodeAt(k + 1) === 42) {
      k = s.indexOf('*', k + 2);
      continue;
    }
    return k;
  }
  return -1;
}

const HTML_ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// One scan for both the Markdown specials and the HTML specials: a plain run
// between matches holds neither, so it is written out verbatim.
const INLINE_RE = /[\\`*[&<>"']/g;

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  const n = s.length;
  let out = '';
  let i = 0;
  let seg = 0; // start of the pending plain run (neither Markdown nor HTML special)
  while (true) {
    INLINE_RE.lastIndex = i;
    const m = INLINE_RE.exec(s);
    if (m === null) break;
    const k = m.index;
    const c = s.charCodeAt(k);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (k > seg) out += s.slice(seg, k);
      out += HTML_ENT[s[k]];
      i = k + 1;
      seg = i;
      continue;
    }
    if (c === 92) {
      if (k + 1 < n && ESCAPABLE.has(s[k + 1])) {
        if (k > seg) out += s.slice(seg, k);
        out += s[k + 1];
        i = k + 2;
        seg = i;
        continue;
      }
      i = k + 1; // a lone backslash stays in the plain run
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', k + 1);
      if (j > k + 1) {
        if (k > seg) out += s.slice(seg, k);
        out += `<code>${escapeHtml(s.slice(k + 1, j))}</code>`;
        i = j + 1;
        seg = i;
      } else i = k + 1;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(k + 1) === 42) {
        const j = findUnescaped(s, '**', k + 2);
        if (j > k + 2) {
          if (k > seg) out += s.slice(seg, k);
          out += `<strong>${inline(s.slice(k + 2, j), env)}</strong>`;
          i = j + 2;
          seg = i;
        } else i = k + 2; // "**" with no closer is itself; it stays in the plain run
        continue;
      }
      const j = findSingleStar(s, k + 1);
      if (j > k + 1) {
        if (k > seg) out += s.slice(seg, k);
        out += `<em>${inline(s.slice(k + 1, j), env)}</em>`;
        i = j + 1;
        seg = i;
      } else i = k + 1;
      continue;
    }
    // '['
    const kk = findUnescaped(s, ']', k + 1);
    const mm = kk !== -1 && s.charCodeAt(kk + 1) === 40 ? s.indexOf(')', kk + 2) : -1;
    const target = mm === -1 ? '' : s.slice(kk + 2, mm);
    if (target !== '' && !WS_RE.test(target)) {
      if (k > seg) out += s.slice(seg, k);
      out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(k + 1, kk), env)}</a>`;
      i = mm + 1;
      seg = i;
      continue;
    }
    i = k + 1;
  }
  if (n > seg) out += s.slice(seg, n);
  return out;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last),
 * its table of contents (every level 2 and 3 heading) and its excerpt (the first
 * paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const out = []; // each block's HTML, already ending in "\n"
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  const N = lines.length;
  let kind = -1; // classifyLine(lines[i]) once known; -1 means not yet classified
  while (i < N) {
    if (kind === -1) kind = classifyLine(lines[i]);
    if (kind === 0) {
      i++;
      kind = -1;
      continue;
    }
    if (kind === 1) {
      const lang = CL_lang;
      const body = [];
      i++;
      while (i < N && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      let code = '';
      for (const l of body) code += `${escapeHtml(l)}\n`;
      out.push(`<pre><code${cls}>${code}</code></pre>\n`);
      kind = -1;
      continue;
    }
    if (kind === 2) {
      const depth = CL_depth;
      const text = CL_text;
      const id = uniqueSlug(slugify(text), ids);
      const html = inline(text, env);
      out.push(`<h${depth} id="${id}">${html}</h${depth}>\n`);
      if (depth === 2 || depth === 3) toc.push({ level: depth, id, html });
      i++;
      kind = -1;
      continue;
    }
    if (kind === 3) {
      out.push('<hr>\n');
      i++;
      kind = -1;
      continue;
    }
    if (kind === 4) {
      const body = [];
      while (i < N && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      out.push(kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>\n`);
      kind = -1;
      continue;
    }
    if (kind === 5 || kind === 6) {
      const isOrdered = kind === 6;
      const startNum = CL_num;
      const items = [];
      while (i < N) {
        const k2 = classifyLine(lines[i]);
        if (isOrdered) {
          if (k2 === 6) {
            items.push([trimLine(CL_text)]);
            i++;
            continue;
          }
        } else if (k2 === 5) {
          items.push([trimLine(CL_text)]);
          i++;
          continue;
        }
        if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
          continue;
        }
        kind = k2; // this line's kind is already known for the outer loop
        break;
      }
      if (i >= N) kind = -1;
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`;
      let itemsHtml = '';
      for (const parts of items) itemsHtml += `<li>${inline(parts.join('\n'), env)}</li>\n`;
      out.push(`${open}\n${itemsHtml}</${tag}>\n`);
      continue;
    }
    // A paragraph: this line and the lines after it up to a blank line, a
    // fence, a heading or a thematic break.
    const body = [trimLine(lines[i])];
    i++;
    while (i < N) {
      kind = classifyLine(lines[i]);
      if (kind === 0 || kind === 1 || kind === 2 || kind === 3) break;
      body.push(trimLine(lines[i]));
      i++;
    }
    if (i >= N) kind = -1;
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    out.push(`<p>${html}</p>\n`);
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scopes, path) {
  for (let s = scopes.length - 1; s >= 0; s--) {
    const vars = scopes[s];
    if (Object.hasOwn(vars, path[0])) {
      let v = vars[path[0]];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** A value as an escaped template variable writes it (numbers and booleans hold no HTML special). */
function varOf(scopes, path) {
  const v = lookup(scopes, path);
  return typeof v === 'number' || typeof v === 'boolean' ? String(v) : escapeHtml(textOf(v));
}

// The helpers a compiled template calls: lookup, textOf, truthy and varOf.
const HELPERS = { lk: lookup, tx: textOf, tr: truthy, vr: varOf };

/**
 * A parsed template compiled into a render function (S scopes, T templates,
 * O output array, D include depth, H helpers). Loops become native loops and
 * the node dispatch disappears; the semantics are the tree walker's, node for
 * node: the same lookup, the same truthiness, the same include depth.
 */
function compileNodes(nodes) {
  const parts = [];
  const gen = (ns) => {
    for (const node of ns) {
      switch (node.kind) {
        case 'text':
          parts.push(`O.push(${JSON.stringify(node.text)});`);
          break;
        case 'var':
          parts.push(`O.push(H.vr(S,${JSON.stringify(node.path)}));`);
          break;
        case 'raw':
          parts.push(`O.push(H.tx(H.lk(S,${JSON.stringify(node.path)})));`);
          break;
        case 'if':
          parts.push(`if(H.tr(H.lk(S,${JSON.stringify(node.path)}))!==${node.not}){`);
          gen(node.then);
          if (node.else !== null) {
            parts.push('}else{');
            gen(node.else);
          }
          parts.push('}');
          break;
        case 'for':
          parts.push(`{const xs=H.lk(S,${JSON.stringify(node.path)});if(Array.isArray(xs)){for(let k=0;k<xs.length;k++){const V={[${JSON.stringify(node.name)}]:xs[k],loop:{index:k+1,first:k===0,last:k===xs.length-1,length:xs.length}};S.push(V);`);
          gen(node.body);
          parts.push('S.pop();}}}');
          break;
        case 'include':
          parts.push(`if(D<${INCLUDE_DEPTH}){const t=T.get(${JSON.stringify(node.name)});if(t!==undefined)t(S,T,O,D+1,H);}`);
          break;
      }
    }
  };
  gen(nodes);
  return new Function('S', 'T', 'O', 'D', 'H', parts.join(''));
}

// Compiled templates, cached by their source (a template's rendering depends
// on its source alone, so the same source compiles once).
const templateCache = new Map();

/** `src` parsed (a TemplateError when it does not parse) and compiled. */
function compileTemplate(name, src) {
  const hit = templateCache.get(src);
  if (hit !== undefined) return hit;
  const fn = compileNodes(parseTemplate(name, src));
  templateCache.set(src, fn);
  return fn;
}

/** `name` rendered with `vars`, or null when the template is missing. */
function renderTemplate(templates, name, vars) {
  const fn = templates.get(name);
  if (fn === undefined) return null;
  const out = [];
  fn([vars], templates, out, 0, HELPERS);
  return out.join('');
}

// ---------------------------------------------------------------- build

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

// The \s whitespace codes, as a table: words are counted by their starts.
const WS_TAB = new Uint8Array(65536);
for (const c of [32, 9, 10, 11, 12, 13, 160, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS_TAB[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS_TAB[c] = 1;

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let prevWS = 1; // the start of the string counts as whitespace
  for (let i = 0; i < text.length; i++) {
    const w = WS_TAB[text.charCodeAt(i)];
    n += prevWS & (w ^ 1);
    prevWS = w;
  }
  return n;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** One site's output tree: path -> text. */
export function run(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = input.files.slice().sort((a, b) => byCodeUnits(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push(f);
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    // Card data, computed once and shared by every list that shows this source.
    s.readingMinutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.readingMinutes,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const linkOf = (s) =>
    s === null
      ? null
      : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => renderTemplate(templates, name, { site, tags: allTags, recent, ...vars });

  const output = {};
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
