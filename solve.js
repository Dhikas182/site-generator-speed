// A faster drop-in for makefun-site 1.0.0 (site-generator-speed-01).
//
// Written from scratch against the reference's README and code: it returns
// byte-for-byte the same answer as makefun-site 1.0.0's build for every input,
// only faster. Nothing is cached from one case to the next: every run() builds
// its own state (slug cache, compiled templates) and throws it away.
//
// Where the speed comes from:
//  - templates are compiled to small JS functions (new Function) that push
//    into an output array; a tree-walking interpreter with identical
//    semantics is the fallback when code generation is unavailable;
//  - Markdown is rendered in one fused pass (no token objects), and inline
//    rendering escapes whole plain runs at once instead of one regex per
//    character;
//  - front matter is found with indexOf and the body is a slice, not a
//    split-and-join;
//  - slugify memoises per build and takes a regex fast path for ASCII text.
//
// Node 22 stdlib only; no imports at all.

const REPORT_FILE = 'build-report.txt';
const RESERVED = Object.freeze(['posts', 'tags', 'page']);
const INCLUDE_DEPTH = 8;

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** The words of a body: its runs of characters other than whitespace. A manual scan: the same runs /\S+/g finds, without building the match array. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // exactly ECMAScript \s: tab, LF, VT, FF, CR, space, NBSP, Ogham space mark,
    // en quad..hair space, line/paragraph separators, narrow no-break space,
    // medium mathematical space, ideographic space, BOM/ZWNBSP
    const ws = c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (!ws) {
      if (!inWord) {
        n++;
        inWord = true;
      }
    } else inWord = false;
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

// ---------------------------------------------------------------- text

/** The HTML escape table, in this order: & < > " ' (README.md). */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;
const HTML_TEST = /[&<>"']/;

/** `text` with & < > " and ' escaped; returned as-is when it holds none of them (no copy). */
function escapeHtml(text) {
  if (!HTML_TEST.test(text)) return text;
  return text.replace(ESCAPE_RE, (c) => ESCAPES[c]);
}

const SLUG_MAX = 64;
const NON_ASCII = /[^\x00-\x7F]/;
const NON_ALNUM_RUN = /[^a-z0-9]+/g;

/** The slug of `text`, exactly as the reference computes it. */
function slugifySlow(text) {
  // After NFKD and dropping combining marks, lowercasing and collapsing every
  // run of non [a-z0-9] to one "-" is what the reference's character loop
  // does; the regex form is the same mapping. A second mark-strip after
  // lowercasing covers the one special-casing (U+0130) whose lowercase
  // introduces a combining mark.
  const plain = NON_ASCII.test(text)
    ? text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\p{M}/gu, '')
    : text.toLowerCase();
  let out = plain.replace(NON_ALNUM_RUN, '-');
  if (out.charCodeAt(0) === 45) out = out.slice(1);
  if (out.charCodeAt(out.length - 1) === 45) out = out.slice(0, -1);
  out = out.slice(0, SLUG_MAX);
  if (out.charCodeAt(out.length - 1) === 45) out = out.slice(0, -1);
  return out === '' ? 'untitled' : out;
}

/** A per-build memoised slugify (titles and tags repeat within a site). */
function makeSlugify() {
  const cache = new Map();
  return (text) => {
    let out = cache.get(text);
    if (out === undefined) {
      out = slugifySlow(text);
      cache.set(text, out);
    }
    return out;
  };
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// ---------------------------------------------------------------- front matter

const KEYS = Object.freeze(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;
const BLANK_LINE = /^[ \t]*$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
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
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text` has "\n"
 * line ends. The closing line is found with indexOf and the body is a slice, not a split-and-join.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  let close = -1; // index of the first "-" of the closing "---" line
  // the "\n" before a closing line on line 1 is at index 3, so search from there
  let p = 3;
  while (true) {
    const nl = text.indexOf('\n---', p);
    if (nl === -1) break;
    const after = nl + 4;
    if (after === text.length || text[after] === '\n') {
      close = nl + 1;
      break;
    }
    p = nl + 1;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  if (close > 4) {
    const hlines = text.slice(4, close - 1).split('\n');
    for (let j = 0; j < hlines.length; j++) {
      const line = hlines[j];
      if (BLANK_LINE.test(line) || line.startsWith('#')) continue;
      const m = LINE.exec(line);
      if (!m) return { error: `line ${j + 2} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const after = close + 3;
  return { data, body: after === text.length ? '' : text.slice(after + 1) };
}

// ---------------------------------------------------------------- Markdown

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const TRIM_LINE = /^[ \t]+|[ \t]+$/g;

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. First-character dispatch: most lines fail all four on the first character. */
function endsParagraph(line) {
  if (line === '') return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return BLANK.test(line);
  if (c0 === 96) return FENCE_OPEN.test(line);
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return HR.test(line);
  return false;
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
const trimLine = (line) => line.replace(TRIM_LINE, '');

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The next index at or after `from` holding one of \ ` * [, or -1. indexOf jumps, no shared regex state. */
function nextSpecial(s, from) {
  let m = -1;
  const a = s.indexOf('\\', from);
  if (a !== -1) m = a;
  const b = s.indexOf('`', from);
  if (b !== -1 && (m === -1 || b < m)) m = b;
  const c = s.indexOf('*', from);
  if (c !== -1 && (m === -1 || c < m)) m = c;
  const d = s.indexOf('[', from);
  if (d !== -1 && (m === -1 || d < m)) m = d;
  return m;
}

const LINK_WS = /\s/;

/**
 * `s` rendered inline; `env.link(target)` is a link's href. Plain runs are
 * escaped whole instead of one regex per character, and a special character
 * that opens no construct stays in the plain run.
 */
function inline(s, env) {
  let p = nextSpecial(s, 0);
  if (p === -1) return escapeHtml(s);
  let out = '';
  let i = 0; // start of the unflushed plain run
  while (p !== -1) {
    const c = s[p];
    if (c === '\\' && p + 1 < s.length && ESCAPABLE.has(s[p + 1])) {
      if (i < p) out += escapeHtml(s.slice(i, p));
      out += s[p + 1];
      i = p + 2;
      p = nextSpecial(s, i);
    } else if (c === '`') {
      const k = s.indexOf('`', p + 1);
      if (k > p + 1) {
        if (i < p) out += escapeHtml(s.slice(i, p));
        out += `<code>${escapeHtml(s.slice(p + 1, k))}</code>`;
        i = k + 1;
        p = nextSpecial(s, i);
      } else {
        p = nextSpecial(s, p + 1);
      }
    } else if (c === '*') {
      if (s[p + 1] === '*') {
        const k = findUnescaped(s, '**', p + 2);
        if (k > p + 2) {
          if (i < p) out += escapeHtml(s.slice(i, p));
          out += `<strong>${inline(s.slice(p + 2, k), env)}</strong>`;
          i = k + 2;
          p = nextSpecial(s, i);
        } else {
          p = nextSpecial(s, p + 2);
        }
      } else {
        const k = findSingleStar(s, p + 1);
        if (k > p + 1) {
          if (i < p) out += escapeHtml(s.slice(i, p));
          out += `<em>${inline(s.slice(p + 1, k), env)}</em>`;
          i = k + 1;
          p = nextSpecial(s, i);
        } else {
          p = nextSpecial(s, p + 1);
        }
      }
    } else if (c === '[') {
      const k = findUnescaped(s, ']', p + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !LINK_WS.test(target)) {
        if (i < p) out += escapeHtml(s.slice(i, p));
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(p + 1, k), env)}</a>`;
        i = m + 1;
        p = nextSpecial(s, i);
      } else {
        p = nextSpecial(s, p + 1);
      }
    } else {
      // a backslash before a character it does not escape: it stays literal
      p = nextSpecial(s, p + 1);
    }
  }
  if (i < s.length) out += escapeHtml(s.slice(i));
  return out;
}

/**
 * `src` rendered in one fused pass (no token objects): its HTML (each block
 * on its own lines, a "\n" after the last), its table of contents (every
 * level 2 and 3 heading: level, id and its inline HTML) and its excerpt (the
 * first paragraph's inline HTML, or ""). `env` holds link(target) and
 * slugify(text).
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      // a line opening on a space or tab is blank or a paragraph line
      if (BLANK.test(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      // a fence opens on ```
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < n) {
          const bl = lines[i];
          if (bl.charCodeAt(0) === 96 && FENCE_CLOSE.test(bl)) break;
          body.push(bl);
          i++;
        }
        i++;
        const lang = fence[1];
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        const raw = body.join('\n');
        blocks.push(`<pre><code${cls}>${raw === '' ? '' : `${escapeHtml(raw)}\n`}</code></pre>`);
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(env.slugify(heading.text), ids);
        const html = inline(heading.text, env);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      // ---, *** or a bullet item
      if (HR.test(line)) {
        blocks.push('<hr>');
        i++;
        continue;
      }
      if (line.charCodeAt(1) === 32) {
        const items = [trimLine(line.slice(2))];
        i++;
        while (i < n) {
          const li = lines[i];
          if ((li.charCodeAt(0) === 45 || li.charCodeAt(0) === 42) && li.charCodeAt(1) === 32) {
            items.push(trimLine(li.slice(2)));
            i++;
          } else if (li.charCodeAt(0) === 32 && li.charCodeAt(1) === 32 && CONTINUED.test(li)) {
            items[items.length - 1] += `\n${trimLine(li)}`;
            i++;
          } else break;
        }
        let html = '<ul>\n';
        for (const item of items) html += `<li>${inline(item, env)}</li>\n`;
        html += '</ul>';
        blocks.push(html);
        continue;
      }
    } else if (c0 === 62) {
      const q = [];
      while (i < n && lines[i][0] === '>') {
        const t = trimLine(lines[i].replace(/^> ?/, ''));
        if (t !== '') q.push(t);
        i++;
      }
      blocks.push(q.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(q.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const ordered = ORDERED.exec(line);
      if (ordered !== null) {
        const items = [trimLine(ordered[2])];
        i++;
        while (i < n) {
          const li = lines[i];
          const d0 = li.charCodeAt(0);
          if (d0 >= 48 && d0 <= 57) {
            const m = ORDERED.exec(li);
            if (m !== null) {
              items.push(trimLine(m[2]));
              i++;
              continue;
            }
          }
          if (li.charCodeAt(0) === 32 && li.charCodeAt(1) === 32 && CONTINUED.test(li)) {
            items[items.length - 1] += `\n${trimLine(li)}`;
            i++;
          } else break;
        }
        const start = Number(ordered[1]);
        const open = start !== 1 ? `<ol start="${start}">` : '<ol>';
        let html = `${open}\n`;
        for (const item of items) html += `<li>${inline(item, env)}</li>\n`;
        html += '</ol>';
        blocks.push(html);
        continue;
      }
    }
    // a paragraph: this line and the lines after it up to a blank line, a fence, a heading or a thematic break
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
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
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
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
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
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

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s, path[0])) s = Object.getPrototypeOf(s);
  if (s === null) return undefined;
  let v = s[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/**
 * `nodes` rendered by tree-walking (the fallback when a template cannot be
 * compiled). Scopes are prototype-chained objects on a null-prototype root,
 * so a first-name load walks exactly the chain lookup() walks. `O` collects
 * the pieces; the caller joins them.
 */
function renderNodes(nodes, scope, depth, O, H) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        O.push(n.text);
        break;
      case 'var':
        O.push(H.esc(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        O.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, depth, O, H);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const child = Object.create(scope);
          if (n.name === '__proto__') Object.defineProperty(child, n.name, { value: xs[k], enumerable: true, writable: true, configurable: true });
          else child[n.name] = xs[k];
          child.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          renderNodes(n.body, child, depth, O, H);
        }
        break;
      }
      case 'include': {
        H.renderTpl(n.name, scope, depth + 1, O, H);
        break;
      }
    }
  }
}

/**
 * Compile a template's node tree to a function (S, D, O, H): S is the scope
 * object, D the include depth, O the output array, H the helpers. Loop
 * variables live on prototype-chained child scopes, so an include sees the
 * same scope as the tree-walker. Returns null when code generation is
 * unavailable; the caller then uses renderNodes.
 */
function compileTemplate(nodes) {
  let uid = 0;
  const parts = [];
  const emitLookup = (path, scopeVar) => {
    // The first name is read off the scope chain (__proto__ is the one name a
    // chain read would answer with the parent scope, so it is undefined).
    const v = `v${uid++}`;
    parts.push(`let ${v}=${path[0] === '__proto__' ? 'undefined' : `${scopeVar}[${JSON.stringify(path[0])}]`};`);
    for (let k = 1; k < path.length; k++) {
      const key = JSON.stringify(path[k]);
      parts.push(`if(${v}!==null&&typeof ${v}==='object'&&Object.hasOwn(${v},${key})){${v}=${v}[${key}];}else{${v}=undefined;}`);
    }
    return v;
  };
  const gen = (ns, scopeVar) => {
    for (const n of ns) {
      if (n.kind === 'text') {
        parts.push(`O.push(${JSON.stringify(n.text)});`);
      } else if (n.kind === 'var' || n.kind === 'raw') {
        const v = emitLookup(n.path, scopeVar);
        parts.push(n.kind === 'var' ? `O.push(H.esc(H.textOf(${v})));` : `O.push(H.textOf(${v}));`);
      } else if (n.kind === 'if') {
        const v = emitLookup(n.path, scopeVar);
        const c = `c${uid++}`;
        parts.push(`const ${c}=H.truthy(${v});`);
        parts.push(n.not ? `if(!${c}){` : `if(${c}){`);
        gen(n.then, scopeVar);
        parts.push('}');
        if (n.else !== null) {
          parts.push('else{');
          gen(n.else, scopeVar);
          parts.push('}');
        }
      } else if (n.kind === 'for') {
        const a = `a${uid++}`;
        const k = `k${uid++}`;
        const s = `s${uid++}`;
        const xs = emitLookup(n.path, scopeVar);
        const bind = n.name === '__proto__'
          ? `Object.defineProperty(${s},${JSON.stringify(n.name)},{value:${a}[${k}],enumerable:true,writable:true,configurable:true});`
          : `${s}[${JSON.stringify(n.name)}]=${a}[${k}];`;
        parts.push(`const ${a}=${xs};if(Array.isArray(${a})){for(let ${k}=0;${k}<${a}.length;${k}++){const ${s}=Object.create(${scopeVar});${bind}${s}.loop={index:${k}+1,first:${k}===0,last:${k}===${a}.length-1,length:${a}.length};`);
        gen(n.body, s);
        parts.push('}}');
      } else if (n.kind === 'include') {
        parts.push(`H.renderTpl(${JSON.stringify(n.name)},${scopeVar},D+1,O,H);`);
      }
    }
  };
  gen(nodes, 'S');
  try {
    return new Function('S', 'D', 'O', 'H', parts.join(''));
  } catch {
    return null;
  }
}

/** Render the template `name` at depth `depth` into `O` (compiling it on first use; a compiled function when it has one, else the tree-walker). */
function renderTpl(name, scope, depth, O, H) {
  if (depth > INCLUDE_DEPTH) return;
  const t = H.templates.get(name);
  if (t === undefined) return;
  if (!t.compiled) {
    t.fn = compileTemplate(t.nodes);
    t.compiled = true;
  }
  if (t.fn !== null) t.fn(scope, depth, O, H);
  else renderNodes(t.nodes, scope, depth, O, H);
}

// ---------------------------------------------------------------- the build

/** One site's output tree: path -> text. */
function build(input) {
  const slugify = makeSlugify();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      const nodes = parseTemplate(name, input.templates[name]);
      templates.set(name, { nodes, fn: null, compiled: false });
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const H = { templates, esc: escapeHtml, textOf, truthy, renderTpl };
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      slugify,
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => {
      const slug = slugify(name);
      if (seen.has(slug)) return false;
      seen.add(slug);
      return true;
    });
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of b.sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const t = bySlug.get(slugify(name));
        return t ?? { name, slug: slugify(name), url: '', posts: [] };
      });
    }
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // A page's link record as templates read it.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  // A tag as templates read it (its posts as cards).
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });
  // A post's card, as lists show it (computed once per source).
  const cardCache = new Map();
  const cardOf = (s) => {
    let c = cardCache.get(s);
    if (c === undefined) {
      c = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
      cardCache.set(s, c);
    }
    return c;
  };
  // A page as its layout reads it.
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, input.site.recent).map((p) => b.cards.get(p));
  const render = (name, vars) => {
    const t = templates.get(name);
    if (t === undefined) return null;
    if (!t.compiled) {
      t.fn = compileTemplate(t.nodes);
      t.compiled = true;
    }
    const root = Object.create(null);
    root.site = site;
    root.tags = allTags;
    root.recent = recent;
    Object.assign(root, vars);
    const O = [];
    if (t.fn !== null) t.fn(root, 0, O, H);
    else renderNodes(t.nodes, root, 0, O, H);
    return O.join('');
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const npages = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${npages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return b.output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
