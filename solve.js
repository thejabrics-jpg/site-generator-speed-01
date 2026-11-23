// A fast drop-in replacement for makefun-site 1.0.0, written for
// site-generator-speed-01. run(input) returns, for every case's input, exactly
// the output tree makefun-site 1.0.0's build returns: the same front matter
// rules, the same Markdown subset, the same template dialect, the same slug,
// link, collection, tag and report rules — byte for byte — but built on
// single-pass scanners, bulk escaping and templates compiled to functions
// instead of per-character recursion and tree walking.

// ---------------------------------------------------------------- text rules

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  ESCAPE_RE.lastIndex = 0;
  let m = ESCAPE_RE.exec(text);
  if (m === null) return text;
  let out = '';
  let i = 0;
  while (m !== null) {
    out += text.slice(i, m.index) + ESCAPES[m[0]];
    i = m.index + 1;
    ESCAPE_RE.lastIndex = i;
    m = ESCAPE_RE.exec(text);
  }
  return out + text.slice(i);
}

/** One character escaped (most characters escape to themselves). */
function escapeChar(ch) {
  const e = ESCAPES[ch];
  return e === undefined ? ch : e;
}

const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most
 * SLUG_MAX characters (a "-" left at the cut dropped), "untitled" when empty.
 */
function slugify(text) {
  // Fast path: pure ASCII is unchanged by NFKD and holds no combining marks.
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** Whether code unit `c` is one JavaScript's \s matches. */
function isWs(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 ||
    c === 8287 || c === 12288 || c === 65279;
}

/** The number of words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWs(text.charCodeAt(i))) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// ------------------------------------------------------------ front matter
// A strict subset of YAML's block mappings: a source opens on a line "---"
// and its front matter runs to the next line "---"; every line between is
// blank, a comment or "key: value" with one space after the colon. Seven keys
// are known, each with its own value grammar; anything else refuses the file
// with the first reason met, line by line.

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function fmString(raw) {
  if (raw.charCodeAt(0) === 34) { // "
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

function isDigit(c) { return c >= 48 && c <= 57; }

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      if (ok) {
        for (const i of [0, 1, 2, 3, 5, 6, 8, 9]) {
          if (!isDigit(raw.charCodeAt(i))) { ok = false; break; }
        }
      }
      if (ok) {
        const y = Number(raw.slice(0, 4));
        const mo = Number(raw.slice(5, 7));
        const d = Number(raw.slice(8, 10));
        ok = y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
      }
      return ok ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t[i];
          if (c === '"' || c === '[' || c === ']') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw === '') return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || isDigit(c) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      // ^[a-z0-9]+(?:-[a-z0-9]+)*$ and at most 64 characters.
      if (raw.length > 64 || raw === '') return { error: 'key "slug": not a slug' };
      let seg = 0;
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if ((c >= 97 && c <= 122) || isDigit(c)) seg++;
        else if (c === 45 && seg > 0) seg = 0;
        else return { error: 'key "slug": not a slug' };
      }
      return seg > 0 ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * One front matter line into `data`: null when fine, else the refusal reason.
 * `lineNo` is the line's 1-based number in the source.
 */
function fmLine(line, lineNo, data) {
  let blank = true;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) { blank = false; break; }
  }
  if (blank || line.charCodeAt(0) === 35) return null; // blank or # comment
  // A U+2028/U+2029 anywhere makes the reference's line pattern fail to match.
  if (line.includes('\u2028') || line.includes('\u2029')) return `line ${lineNo} is not "key: value"`;
  // ^([a-z_]+):(?: (.*))?$
  let k = 0;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if ((c >= 97 && c <= 122) || c === 95) k++;
    else break;
  }
  if (k === 0 || line[k] !== ':') return `line ${lineNo} is not "key: value"`;
  const key = line.slice(0, k);
  let raw;
  if (k + 1 === line.length) raw = '';
  else if (line[k + 1] === ' ') raw = line.slice(k + 2).replace(/[ \t]+$/, '');
  else return `line ${lineNo} is not "key: value"`;
  if (!FM_KEYS.has(key)) return `unknown key "${key}"`;
  if (Object.hasOwn(data, key)) return `key "${key}" is given twice`;
  if (raw === '') return `key "${key}" has no value`;
  const v = fmValue(key, raw);
  if ('error' in v) return v.error;
  data[key] = v.value;
  return null;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  const first = nl0 === -1 ? text : text.slice(0, nl0);
  if (first !== '---') return { error: 'no front matter' };
  if (nl0 === -1) return { error: 'the front matter is not closed' };
  // First pass: find the closing line, as the reference does before parsing.
  const lineStarts = [nl0 + 1];
  let closeStart = -1;
  let closeEnd = -1;
  {
    let pos = nl0 + 1;
    while (pos <= text.length) {
      const nl = text.indexOf('\n', pos);
      const end = nl === -1 ? text.length : nl;
      if (end - pos === 3 && text.startsWith('---', pos)) { closeStart = pos; closeEnd = end; break; }
      if (nl === -1) break;
      lineStarts.push(nl + 1);
      pos = nl + 1;
    }
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let li = 0; li < lineStarts.length; li++) {
    const start = lineStarts[li];
    if (start >= closeStart) break;
    const end = li + 1 < lineStarts.length ? lineStarts[li + 1] - 1 : closeStart - 1;
    const err = fmLine(text.slice(start, Math.max(start, end)), li + 2, data);
    if (err !== null) return { error: err };
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeEnd === text.length ? '' : text.slice(closeEnd + 1);
  return { data, body };
}

// ------------------------------------------------------------------ Markdown
// makefun-site's own subset, lexed into block tokens and then rendered.
// Blocks: ATX headings (each with an id), fenced code, thematic breaks,
// blockquotes, flat lists and paragraphs. Inline: code spans, strong,
// emphasis, links and backslash escapes. No raw HTML, no setext headings, no
// indented code, no tables, no reference links, no underscore emphasis.

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Trailing spaces and tabs dropped. */
function rstripLine(line) {
  let e = line.length;
  while (e > 0) {
    const c = line.charCodeAt(e - 1);
    if (c === 32 || c === 9) e--;
    else break;
  }
  return e === line.length ? line : line.slice(0, e);
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c === 32 || c === 9) a++;
    else break;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  return line.slice(a, b);
}

function isFenceLang(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || isDigit(c) || c === 95 || c === 43 || c === 45;
}

/** A fence opening line's language, or null: ```lang then only blanks. */
function fenceOpen(line) {
  if (!line.startsWith('```')) return null;
  let i = 3;
  while (i < line.length && isFenceLang(line.charCodeAt(i))) i++;
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether `line` closes a fence: ``` then only blanks. */
function fenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6) return null;
  if (h === line.length) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  if (line.includes('\u2028') || line.includes('\u2029')) return null;
  let i = h;
  while (i < line.length) {
    const cc = line.charCodeAt(i);
    if (cc === 32 || cc === 9) i++;
    else break;
  }
  const text = rstripLine(line.slice(i));
  return text === '' ? null : { depth: h, text };
}

/** Whether `line` is a thematic break: --- or *** then only blanks. */
function isHr(line) {
  const t = rstripLine(line);
  return t === '---' || t === '***';
}

/** A bullet item's content, or null: "- " or "* " then the rest of the line. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) {
    if (line.includes('\u2028') || line.includes('\u2029')) return null;
    return line.slice(2);
  }
  return null;
}

/** An ordered item's start and content, or null: 1-9 digits, ". ", the rest. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && isDigit(line.charCodeAt(i))) i++;
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  if (line.includes('\u2028') || line.includes('\u2029')) return null;
  return { start: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** Whether `line` continues a list item: at least two spaces, then non-blank. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i >= 2 && i < line.length && !isWs(line.charCodeAt(i));
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlankLine(line);
  if (c === 96) return fenceOpen(line) !== null; // `
  if (c === 35) return headingOf(line) !== null; // #
  if (c === 45 || c === 42) return isHr(line); // - or *
  return line.length === 0;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

/** Whether `s` holds any whitespace. */
function hasWs(s) {
  for (let i = 0; i < s.length; i++) if (isWs(s.charCodeAt(i))) return true;
  return false;
}

/** The characters that interrupt a plain run of inline text. */
const INLINE_SPECIAL_RE = /[\\`*\[&<>"']/g;

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    INLINE_SPECIAL_RE.lastIndex = i;
    const m = INLINE_SPECIAL_RE.exec(s);
    if (m === null) { out += s.slice(i); break; }
    const idx = m.index;
    if (idx > i) out += s.slice(i, idx);
    const ch = m[0];
    i = idx;
    if (ch === '\\') {
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) { out += escapeChar(s[i + 1]); i += 2; }
      else { out += '\\'; i++; }
    } else if (ch === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) { out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`; i = j + 1; }
      else { out += '`'; i++; }
    } else if (ch === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) { out += `<strong>${inline(s.slice(i + 2, j), env)}</strong>`; i = j + 2; }
        else { out += '**'; i += 2; }
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) { out += `<em>${inline(s.slice(i + 1, j), env)}</em>`; i = j + 1; }
        else { out += '*'; i++; }
      }
    } else if (ch === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !hasWs(target)) {
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
        i = mm + 1;
      } else { out += '['; i++; }
    } else {
      out += ESCAPES[ch];
      i++;
    }
  }
  return out;
}

/**
 * `src` rendered in one pass over its lines: its HTML (each block on its own
 * lines, a "\n" after the last), its table of contents (every level 2 and 3
 * heading: level, id and its inline HTML) and its excerpt (the first
 * paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = null;
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    // The block tests are disjoint by first character, so dispatch on it:
    // blank lines, fences (`), headings (#), breaks and bullets (- or *),
    // blockquotes (>) and ordered items (a digit) before paragraphs.
    if (c0 === 32 || c0 === 9 || line.length === 0) {
      if (isBlankLine(line)) { i++; continue; }
    } else if (c0 === 96) { // `
      const fence = fenceOpen(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < lines.length && !fenceClose(lines[i])) body.push(lines[i++]);
        i++;
        const cls = fence === '' ? '' : ` class="language-${escapeHtml(fence)}"`;
        const inner = body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`;
        parts.push(`<pre><code${cls}>${inner}</code></pre>`, '\n');
        continue;
      }
    } else if (c0 === 35) { // #
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inline(heading.text, env);
        parts.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`, '\n');
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) { // - or *
      if (isHr(line)) { parts.push('<hr>', '\n'); i++; continue; }
      const bullet = bulletOf(line);
      if (bullet !== null) {
        const items = [[trimLine(bullet)]];
        i++;
        while (i < lines.length) {
          const m = bulletOf(lines[i]);
          if (m !== null) { items.push([trimLine(m)]); i++; }
          else if (isContinued(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
          else break;
        }
        let inner = '';
        for (const itemParts of items) inner += `<li>${inline(itemParts.join('\n'), env)}</li>\n`;
        parts.push(`<ul>\n${inner}</ul>`, '\n');
        continue;
      }
    } else if (c0 === 62) { // >
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        const t = trimLine(l);
        if (t !== '') body.push(t);
      }
      parts.push(body.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(body.join('\n'), env)}</p>\n</blockquote>`, '\n');
      continue;
    } else if (c0 >= 48 && c0 <= 57) { // a digit
      const ordered = orderedOf(line);
      if (ordered !== null) {
        const items = [[trimLine(ordered.text)]];
        i++;
        while (i < lines.length) {
          const m = orderedOf(lines[i]);
          if (m !== null) { items.push([trimLine(m.text)]); i++; }
          else if (isContinued(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
          else break;
        }
        let inner = '';
        for (const itemParts of items) inner += `<li>${inline(itemParts.join('\n'), env)}</li>\n`;
        const open = ordered.start !== 1 ? `<ol start="${ordered.start}">` : '<ol>';
        parts.push(`${open}\n${inner}</ol>`, '\n');
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    parts.push(`<p>${html}</p>`, '\n');
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// ----------------------------------------------------------------- templates
// makefun-site's template dialect, its own:
//   {{ path }}               the value at path, HTML-escaped
//   {{{ path }}}             the value at path, raw
//   {% for x in path %} ... {% endfor %}
//   {% if path %} ... {% else %} ... {% endif %}   and {% if not path %}
//   {% include "name" %}     the template `name` in the same scope
// A {% %} tag alone on its line takes its whole line with it. Templates are
// parsed once per build into a node tree, then compiled to a function.

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  // ^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$
  const parts = text.split('.');
  for (const p of parts) {
    if (p === '') throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
    const c0 = p.charCodeAt(0);
    if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122) || c0 === 95)) {
      throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
    }
    for (let i = 1; i < p.length; i++) {
      const c = p.charCodeAt(i);
      if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || isDigit(c) || c === 95)) {
        throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
      }
    }
  }
  return parts;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenizeTemplate(name, src) {
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
    let standalone = true;
    for (let k = lineStart; k < open; k++) {
      const c = src.charCodeAt(k);
      if (c !== 32 && c !== 9) { standalone = false; break; }
    }
    if (standalone) {
      for (let k = end; k < lineEnd; k++) {
        const c = src.charCodeAt(k);
        if (c !== 32 && c !== 9) { standalone = false; break; }
      }
    }
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenizeTemplate(name, src)) {
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
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ', ';
      out += textOf(v[i]);
    }
    return out;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The constant reference for a lookup path, hoisted out of the render loop. */
function pathRef(path, state) {
  const key = JSON.stringify(path);
  let id = state.pathIds.get(key);
  if (id === undefined) {
    id = state.paths.length;
    state.paths.push(key);
    state.pathIds.set(key, id);
  }
  return `P${id}`;
}

/** Code for `nodes` rendered into `out`, with the scope in the variable named `sv`. */
function genNodes(nodes, sv, state) {
  let code = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        code += `out+=${JSON.stringify(n.text)};`;
        break;
      case 'var':
        code += `out+=esc(textOf(lookup(${sv},${pathRef(n.path, state)})));`;
        break;
      case 'raw':
        code += `out+=textOf(lookup(${sv},${pathRef(n.path, state)}));`;
        break;
      case 'if': {
        code += `if(truthy(lookup(${sv},${pathRef(n.path, state)}))!==${n.not}){`;
        code += genNodes(n.then, sv, state);
        if (n.else !== null) {
          code += '}else{';
          code += genNodes(n.else, sv, state);
        }
        code += '}';
        break;
      }
      case 'for': {
        const u = state.next++;
        const xs = `_xs${u}`;
        const len = `_n${u}`;
        const k = `_k${u}`;
        const sc = `_s${u}`;
        code += `{const ${xs}=lookup(${sv},${pathRef(n.path, state)});if(Array.isArray(${xs})){const ${len}=${xs}.length;for(let ${k}=0;${k}<${len};${k}++){const ${sc}={vars:{[${JSON.stringify(n.name)}]:${xs}[${k}],loop:{index:${k}+1,first:${k}===0,last:${k}===${len}-1,length:${len}}},parent:${sv}};`;
        code += genNodes(n.body, sc, state);
        code += '}}}';
        break;
      }
      case 'include':
        code += `{const _f=F.get(${JSON.stringify(n.name)});if(_f!==undefined&&D<${INCLUDE_DEPTH})out+=_f(${sv},F,D+1,lookup,textOf,truthy,esc);}`;
        break;
    }
  }
  return code;
}

/** A parsed template compiled to a render function (scope, templates, depth, lookup, textOf, truthy, esc) -> string. */
function compileTemplate(nodes) {
  const state = { next: 0, paths: [], pathIds: new Map() };
  const code = genNodes(nodes, 'S', state);
  const consts = state.paths.length === 0 ? '' : `const ${state.paths.map((p, i) => `P${i}=${p}`).join(',')};`;
  return new Function('S', 'F', 'D', 'lookup', 'textOf', 'truthy', 'esc', `"use strict";${consts}let out="";${code}return out;`);
}

// ------------------------------------------------------------------- the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
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

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One site's output tree: path -> text. Exactly makefun-site 1.0.0's build. */
export function run(input) {
  // The templates, parsed and compiled in code-unit order of their names; a
  // template that does not parse is reported and absent.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n";
  // a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped,
  // and so is a draft.
  {
    const kept = [];
    for (const s of sources) {
      const fm = parseFrontMatter(s.text);
      if ('error' in fm) {
        report.push(`refused ${s.path}: ${fm.error}`);
        continue;
      }
      s.data = fm.data;
      s.body = fm.body;
      s.post = s.path.startsWith('posts/');
      const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
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
    sources = kept;
  }

  // 3. Each page's output directory and url: its slug made unique in its
  // directory, in source order.
  const bySource = new Map();
  {
    const taken = new Map();
    const takenIn = (dir) => {
      if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
      return taken.get(dir);
    };
    for (const s of sources) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
      s.slug = slug;
      s.outDir = dir === '' ? slug : `${dir}/${slug}`;
      s.url = `${base}/${s.outDir}/`;
      bySource.set(s.path, s);
    }
  }

  // 4. Each body's Markdown, its links resolved to the pages and static
  // files they name.
  const broken = new Set();
  {
    const staticPaths = new Set(statics.map((f) => f.path));
    const linkCache = new Map();
    for (const s of sources) {
      const dir = dirOf(s.path);
      const env = {
        link: (target) => {
          if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
          const key = `${dir}\u0000${target}`;
          let hit = linkCache.get(key);
          if (hit === undefined) {
            const hash = target.indexOf('#');
            const rel = hash === -1 ? target : target.slice(0, hash);
            const frag = hash === -1 ? '' : target.slice(hash);
            const path = rel === '' ? null : resolvePath(dir, rel);
            if (path !== null && bySource.has(path)) hit = `${bySource.get(path).url}${frag}`;
            else if (path !== null && staticPaths.has(path)) hit = `${base}/${path}${frag}`;
            else hit = null;
            linkCache.set(key, hit);
          }
          if (hit !== null) return hit;
          broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        },
      };
      const md = renderMarkdown(s.body, env);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
    }
  }

  // 5. The posts, newest first and then by slug; each post's neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the
  // posts' order, ordered by count and then slug.
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => !seen.has(slugify(name)) && seen.add(slugify(name)));
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // The records templates read.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardCache = new Map();
  const cardOf = (s) => {
    let card = cardCache.get(s);
    if (card === undefined) {
      card = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
      cardCache.set(s, card);
    }
    return card;
  };
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) });
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. Every page through its layout, the index pages and the tag pages
  // through theirs.
  const output = {};
  {
    const site = { title: input.site.title, base_url: base };
    const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
    const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
    const render = (name, vars) => {
      const fn = templates.get(name);
      return fn === undefined ? null : fn({ vars: { site, tags: allTags, recent, ...vars }, parent: null }, templates, 0, lookup, textOf, truthy, escapeHtml);
    };
    for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
    const per = input.site.per_page;
    const pages = Math.max(1, Math.ceil(posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
    for (let k = 1; k <= pages; k++) {
      const html = render('index', {
        posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
        pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      });
      if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
    for (const t of tags) {
      const html = render('tag', { tag: tagOf(t) });
      if (html !== null) output[`tags/${t.slug}/index.html`] = html;
    }
    const tagsHtml = render('tags', {});
    if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
    for (const f of statics) {
      if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
      else output[f.path] = f.content;
    }
  }

  // 8. The report: every refusal, draft, broken link and template that did
  // not parse, sorted, then the counts.
  {
    const lines = [...report, ...broken].sort(byCodeUnits);
    const pages = sources.filter((s) => !s.post).length;
    lines.push(`built ${pages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
    output[REPORT_FILE] = `${lines.join('\n')}\n`;
  }
  return output;
}
