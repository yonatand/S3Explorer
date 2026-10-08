// The search query language (see "Search in a bucket" in docs/CONTRACT.md), shared by the mock
// backend and the UI (which highlights matches with the same rules the backend matched with).
//
//   word            the key contains `word` (case-insensitive)
//   "two words"     the key contains the phrase
//   -word -"a b"    the key does not contain it
//   tag:key=value   a tag with exactly that key and that value (value case-insensitive)
//   tag:key         a tag with that key, any value
//   a/path/term     a word that also narrows the listing to its folder

import type { ParsedSearch, SearchTagTerm, Tag } from "./types";

/** Lowercase the way the matcher does: Unicode lowercase, no normalization. */
export const lower = (s: string) => s.toLowerCase();

interface Token {
  /** The term with its quotes removed (and without a leading "-"). */
  text: string;
  /** It contained a quote anywhere: a phrase (unless it is a tag term), never a word or path term. */
  quoted: boolean;
  /** Led by "-" (an exclusion). */
  negated: boolean;
  /** Starts with "tag:" (any case) as typed, before quotes are removed: `"tag:x"` is a phrase. */
  tagPrefix: boolean;
  /** Starts with "path:" (any case) as typed: a path term even when quoted (`path:"a b/c.txt"`). */
  pathPrefix: boolean;
}

/** Unicode whitespace (Rust's `char::is_whitespace`). */
const SPACE = /\p{White_Space}/u;

/**
 * Split on Unicode whitespace outside double quotes. Quotes group inside a term as well as around
 * it (`tag:k="a b"`, `foo"bar baz"` -> `foobar baz`) and are dropped; an unterminated quote runs to
 * the end. Empty phrases (`""`, `-""`) are dropped here, before anything else is decided.
 */
function tokenize(input: string): Token[] {
  const out: Token[] = [];
  const chars = [...input];
  let i = 0;
  while (i < chars.length) {
    if (SPACE.test(chars[i])) {
      i++;
      continue;
    }
    // `raw` is the term as typed; `text` drops the grouping quotes and turns `\"` into a literal `"`.
    let raw = "";
    let text = "";
    let quoted = false;
    let inQuote = false;
    while (i < chars.length && (inQuote || !SPACE.test(chars[i]))) {
      if (chars[i] === "\\" && chars[i + 1] === '"') {
        raw += '\\"';
        text += '"';
        i += 2;
        continue;
      }
      if (chars[i] === '"') {
        inQuote = !inQuote;
        quoted = true;
      } else text += chars[i];
      raw += chars[i];
      i++;
    }
    const negated = raw.length > 1 && raw.startsWith("-");
    const body = negated ? raw.slice(1) : raw;
    if (negated) text = text.slice(1);
    // The prefixes are checked as typed, before quotes are removed: `"tag:x"` is a phrase.
    const tagPrefix = body.slice(0, 4).toLowerCase() === "tag:";
    const pathPrefix = !negated && body.slice(0, 5).toLowerCase() === "path:";
    if (text === "" && (quoted || negated)) continue; // an empty phrase
    if (pathPrefix && text.length === 5) continue; // `path:` with an empty value
    out.push({ text, quoted, negated, tagPrefix, pathPrefix });
  }
  return out;
}

/** The folder part of a path term: up to and including its last "/". */
const dirOf = (term: string) => term.slice(0, term.lastIndexOf("/") + 1);

/**
 * Parse a query typed into the search box. `scope` is the prefix being searched ("" = the whole
 * bucket); `listPrefix` is narrowed from it by a path term when the term's folder is inside it.
 * Returns null when the query has no terms (the backend answers InvalidInput).
 */
export function parseSearch(text: string, scope: string): ParsedSearch | null {
  const words: string[] = [];
  const phrases: string[] = [];
  const excluded: string[] = [];
  const tags: SearchTagTerm[] = [];
  const pathTerms: string[] = [];
  const tokens = tokenize(text).filter((t) => t.text !== "");
  let exactPath: string | null = null;
  for (const t of tokens) {
    if (t.negated) {
      excluded.push(lower(t.text));
      continue;
    }
    // "tag:" in any case; an empty key ("tag:", "tag:=v") is an ordinary word.
    if (t.tagPrefix) {
      const body = t.text.slice(4);
      const eq = body.indexOf("=");
      const key = eq < 0 ? body : body.slice(0, eq);
      if (key) {
        tags.push({ key, value: eq < 0 ? null : body.slice(eq + 1) });
        continue;
      }
    }
    // `path:<value>`: a path term even with quotes or spaces; it narrows and may be the exact path.
    if (t.pathPrefix) {
      const value = t.text.slice(5);
      words.push(lower(value));
      pathTerms.push(value);
      if (tokens.length === 1) exactPath = value;
      continue;
    }
    // Any other term that contained a quote is a phrase: `foo"bar baz"` -> "foobar baz".
    if (t.quoted) {
      phrases.push(lower(t.text));
      continue;
    }
    words.push(lower(t.text));
    if (t.text.includes("/")) {
      pathTerms.push(t.text);
      if (tokens.length === 1) exactPath = t.text;
    }
  }
  if (!words.length && !phrases.length && !excluded.length && !tags.length) return null;

  // Narrow the listing: the longest path-term folder that lies inside the scope.
  let listPrefix = scope;
  for (const term of pathTerms) {
    const dir = dirOf(term);
    if (dir.startsWith(scope) && dir.length > listPrefix.length) listPrefix = dir;
  }
  return { words, phrases, excluded, tags, exactPath, listPrefix };
}

/** Does the key pass the word, phrase and exclusion terms? */
export function matchesText(key: string, q: ParsedSearch): boolean {
  const k = lower(key);
  for (const w of q.words) if (!k.includes(w)) return false;
  for (const p of q.phrases) if (!k.includes(p)) return false;
  for (const x of q.excluded) if (k.includes(x)) return false;
  return true;
}

/** Does the object's tag set pass every tag term? Keys are case-sensitive, values are not. */
export function matchesTags(tags: Tag[], terms: SearchTagTerm[]): boolean {
  return terms.every((term) =>
    tags.some((t) => t.key === term.key && (term.value === null || lower(t.value) === lower(term.value))),
  );
}

/**
 * Ranges [start, end) of `text` that contain any of `needles` (already lowercased), merged and
 * sorted, as offsets into the original string. The text is lowercased whole, as the matcher does
 * (so a Greek final sigma lowercases in context); a per-code-point pass only maps offsets back. If
 * the two lowercasings differ in length, the per-code-point copy is searched instead.
 */
export function highlightRanges(text: string, needles: string[]): [number, number][] {
  const terms = needles.filter((n) => n.length > 0);
  if (!terms.length || !text) return [];
  let low = "";
  const origin: number[] = []; // origin[i] = index in `text` of the code point that produced low[i]
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const l = lower(ch);
    for (let j = 0; j < l.length; j++) origin.push(i);
    low += l;
    i += ch.length;
  }
  const whole = lower(text);
  if (whole.length === low.length) low = whole;
  const ranges: [number, number][] = [];
  for (const term of terms) {
    for (let at = low.indexOf(term); at >= 0; at = low.indexOf(term, at + 1)) {
      // The end is just past the code point that produced the last matched piece.
      const last = origin[at + term.length - 1];
      const end = last + String.fromCodePoint(text.codePointAt(last)!).length;
      ranges.push([origin[at], end]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** The terms a result highlights: words (path terms included) and phrases. */
export const highlightTerms = (q: ParsedSearch): string[] => [...q.words, ...q.phrases];

/**
 * A pasted `s3://bucket/path` as the whole query: the bucket and the rest (which is searched as a
 * lone path term). Null for anything else. The path is passed on exactly as typed.
 */
export function parseS3Path(text: string): { bucket: string; path: string } | null {
  const m = /^s3:\/\/([^/\s]+)(?:\/([\s\S]*))?$/i.exec(text.trim());
  return m ? { bucket: m[1], path: m[2] ?? "" } : null;
}
