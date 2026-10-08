//! `search_objects`: a bounded scan of keys matched against a small query language (words,
//! "phrases", -exclusions, tag:key=value, path terms). See "Search in a bucket" in
//! `docs/CONTRACT.md`.
//!
//! Keys are opaque: nothing typed is normalized except lowercasing for the case-insensitive
//! comparison. The exact path and the listing prefix are sent byte-for-byte as typed.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use aws_sdk_s3::Client;
use futures::stream::{self, StreamExt};
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult, ErrorCode};
use crate::models::{
    last_segment, FolderEntry, SearchHitKind,
    ObjectEntry, ParsedSearch, SearchHit, SearchQuery, SearchResult, SearchTagTerm, Tag, SEARCH_LIMIT_MAX,
    SEARCH_LIMIT_MIN, SEARCH_MAX_PAGES, SEARCH_MAX_SCAN, SEARCH_MAX_TAG_LOOKUPS, SEARCH_TAG_PARALLELISM,
};
use crate::ops::{listing_error, next_list_page, object_entry, NextPage};

/// The parsed query plus the path terms as typed (case kept), which narrow the listing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    /// `list_prefix` is left empty; see [`list_prefix`].
    pub search: ParsedSearch,
    pub path_terms: Vec<String>,
}

impl ParsedSearch {
    /// No term at all: nothing to search for.
    pub fn is_empty(&self) -> bool {
        self.words.is_empty() && self.phrases.is_empty() && self.excluded.is_empty() && self.tags.is_empty()
    }
}

/// One whitespace-separated term, classified on the text as typed (before quotes are removed).
struct Term {
    /// The term without its leading `-` and without quote characters.
    text: String,
    /// Led by `-` (and longer than just `-`): an exclusion.
    negated: bool,
    /// A quote character appeared (after the `-`): a phrase, never a path term.
    quoted: bool,
    /// Starts with `tag:` (any case) as typed, so `"tag:x"` is a phrase, not a tag term.
    tag_prefix: bool,
    /// Starts with `path:` (any case) as typed: a path term even when its value was quoted.
    path_prefix: bool,
}

/// Splits on Unicode whitespace outside quotes. A quote anywhere in a term toggles "inside
/// quotes" (whitespace inside does not split) and is dropped; an unterminated quote runs to the
/// end of the text. Empty terms (`""`, `-""`) are dropped here, before anything else is decided.
fn terms(text: &str) -> Vec<Term> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_whitespace() {
            i += 1;
            continue;
        }
        // `raw` is the term as typed; `text` drops the grouping quotes and turns `\"` into a
        // literal `"` (which does not toggle quoting); any other backslash stays as typed.
        let mut raw: Vec<char> = Vec::new();
        let mut text = String::new();
        let mut quoted = false;
        let mut in_quote = false;
        while i < chars.len() && (in_quote || !chars[i].is_whitespace()) {
            if chars[i] == '\\' && chars.get(i + 1) == Some(&'"') {
                raw.extend(['\\', '"']);
                text.push('"');
                i += 2;
                continue;
            }
            if chars[i] == '"' {
                in_quote = !in_quote;
                quoted = true;
            } else {
                text.push(chars[i]);
            }
            raw.push(chars[i]);
            i += 1;
        }
        let negated = raw.len() > 1 && raw[0] == '-';
        let body = if negated { &raw[1..] } else { &raw[..] };
        if negated {
            text.remove(0);
        }
        if text.is_empty() {
            continue;
        }
        let head = |n: usize| body.iter().take(n).collect::<String>();
        let tag_prefix = head(TAG_PREFIX.len()).eq_ignore_ascii_case(TAG_PREFIX);
        let path_prefix = head(PATH_PREFIX.len()).eq_ignore_ascii_case(PATH_PREFIX);
        // `path:` with nothing after it is no term at all.
        if path_prefix && !negated && text.len() == PATH_PREFIX.len() {
            continue;
        }
        out.push(Term { text, negated, quoted, tag_prefix, path_prefix });
    }
    out
}

const TAG_PREFIX: &str = "tag:";
const PATH_PREFIX: &str = "path:";

/// Parses the query as typed. Words, phrases and exclusions are lowercased (Unicode); tag keys
/// and values and path terms keep their case (tag keys compare case-sensitively, as S3 does).
/// Order of decisions per term: `-` (exclusion), then `tag:` (tag term, unless the key is empty),
/// then `path:` (a path term, quoted or not), then any quote (phrase), else a word (a path term
/// when it contains `/`).
pub fn parse(text: &str) -> Parsed {
    let terms = terms(text);
    let single = terms.len() == 1;
    let mut s = ParsedSearch::default();
    let mut path_terms = Vec::new();
    for t in terms {
        if t.negated {
            s.excluded.push(t.text.to_lowercase());
            continue;
        }
        if t.tag_prefix {
            let rest = &t.text[TAG_PREFIX.len()..];
            let (key, value) = match rest.split_once('=') {
                Some((k, v)) => (k, Some(v.to_string())),
                None => (rest, None),
            };
            // Without a key ("tag:", "tag:=v") it is an ordinary word.
            if !key.is_empty() {
                s.tags.push(SearchTagTerm { key: key.to_string(), value });
                continue;
            }
        }
        // `path:a b/c.txt` (value quoted or not): a path term whatever the quotes.
        if t.path_prefix {
            let value = &t.text[PATH_PREFIX.len()..];
            if single {
                s.exact_path = Some(value.to_string());
            }
            path_terms.push(value.to_string());
            s.words.push(value.to_lowercase());
            continue;
        }
        if t.quoted {
            s.phrases.push(t.text.to_lowercase());
            continue;
        }
        if t.text.contains('/') {
            if single {
                s.exact_path = Some(t.text.clone());
            }
            path_terms.push(t.text.clone());
        }
        s.words.push(t.text.to_lowercase());
    }
    Parsed { search: s, path_terms }
}

/// The prefix to list: `scope`, narrowed to the longest folder part (up to and including the last
/// `/`) of a path term that lies inside `scope`. A path term above or beside `scope` does not
/// change it (it still matches as a word).
pub fn list_prefix(scope: &str, path_terms: &[String]) -> String {
    let mut best = scope;
    for t in path_terms {
        let Some(i) = t.rfind('/') else { continue };
        let dir = &t[..=i];
        if dir.starts_with(scope) && dir.len() > best.len() {
            best = dir;
        }
    }
    best.to_string()
}

/// Whether the key (already lowercased) contains every word and phrase and no exclusion.
pub fn matches(p: &ParsedSearch, key_lower: &str) -> bool {
    p.words.iter().all(|w| key_lower.contains(w.as_str()))
        && p.phrases.iter().all(|w| key_lower.contains(w.as_str()))
        && !p.excluded.iter().any(|w| key_lower.contains(w.as_str()))
}

/// Whether the tag set satisfies every tag term: the key exactly, the value case-insensitively.
pub fn tags_match(terms: &[SearchTagTerm], tags: &[Tag]) -> bool {
    terms.iter().all(|term| {
        tags.iter().any(|t| {
            t.key == term.key && term.value.as_ref().is_none_or(|v| t.value.to_lowercase() == v.to_lowercase())
        })
    })
}

/// 50000 -> "50,000".
fn thousands(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stop {
    Limit(usize),
    Scan,
    Tags,
    Pages,
}

impl Stop {
    fn reason(self) -> String {
        match self {
            Stop::Limit(1) => "Stopped at 1 result".to_string(),
            Stop::Limit(n) => format!("Stopped at {} results", thousands(n as u64)),
            Stop::Scan => format!("Stopped after scanning {} objects", thousands(SEARCH_MAX_SCAN)),
            Stop::Tags => format!("Stopped after {} tag lookups", thousands(SEARCH_MAX_TAG_LOOKUPS)),
            Stop::Pages => format!("Stopped after listing {} pages", SEARCH_MAX_PAGES),
        }
    }
}

pub const EMPTY_QUERY: &str = "Type something to search for: a word, a \"phrase\", -word, tag:key=value or folder/part";
pub const TAG_PERMISSION: &str = "Searching by tag needs the s3:GetObjectTagging permission";

/// Validates the query and parses it (with `list_prefix` filled in).
pub fn prepare(q: &SearchQuery) -> AppResult<Parsed> {
    if q.bucket.trim().is_empty() {
        return Err(AppError::invalid("Bucket name is required"));
    }
    if !(SEARCH_LIMIT_MIN..=SEARCH_LIMIT_MAX).contains(&q.limit) {
        return Err(AppError::invalid(format!(
            "limit must be between {SEARCH_LIMIT_MIN} and {SEARCH_LIMIT_MAX}, got {}",
            q.limit
        )));
    }
    let mut parsed = parse(&q.text);
    if parsed.search.is_empty() {
        return Err(AppError::invalid(EMPTY_QUERY));
    }
    parsed.search.list_prefix = list_prefix(&q.scope, &parsed.path_terms);
    Ok(parsed)
}

/// Only a broken connection, credentials or bucket fail the search on the exact-path checks;
/// anything else about this one key or prefix (missing, denied, SSE-C, too long, a redirect...)
/// just means "no exact hit".
fn exact_check_fails(e: &AppError) -> bool {
    matches!(e.code, ErrorCode::Network | ErrorCode::Auth | ErrorCode::NoSuchBucket)
}

fn object_hit(entry: ObjectEntry, tags: Option<Vec<Tag>>, exact: bool) -> SearchHit {
    SearchHit { kind: SearchHitKind::Object, entry: Some(entry), folder: None, tags, exact }
}

fn folder_hit(prefix: &str, exact: bool) -> SearchHit {
    SearchHit {
        kind: SearchHitKind::Folder,
        entry: None,
        folder: Some(FolderEntry { prefix: prefix.to_string(), name: last_segment(prefix) }),
        tags: None,
        exact,
    }
}

/// The folder prefixes of `key` strictly below the listed prefix (`base_len` bytes long) that the
/// previous key of the listing did not already have: each `/`-delimited ancestor, and the key
/// itself when it is a folder marker. A listing is in byte order, so all keys under a prefix are
/// contiguous: a prefix not shared with the previous key has never been seen before. That makes
/// de-duplication O(depth) memory instead of a set of every folder.
pub fn new_folders<'a>(key: &'a str, prev: Option<&str>, base_len: usize) -> impl Iterator<Item = &'a str> + 'a {
    let prev = prev.map(str::to_string);
    key.bytes().enumerate().filter(move |&(i, b)| b == b'/' && i >= base_len).filter_map(move |(i, _)| {
        let p = &key[..=i];
        (!prev.as_deref().is_some_and(|q| q.starts_with(p))).then_some(p)
    })
}

/// Runs one search (not cancellable by itself; see [`SearchRegistry::run`]).
///
/// Result order: exact hits (folder, then object), then folder hits in prefix order, then object
/// hits in key order; every hit counts toward `limit`.
pub async fn search(client: &Client, q: &SearchQuery) -> AppResult<SearchResult> {
    let mut parsed = prepare(q)?.search;
    let bucket = q.bucket.as_str();
    let limit = q.limit as usize;
    let with_tags = !parsed.tags.is_empty();
    let mut exact: Vec<SearchHit> = Vec::new();

    // The exact path, as typed, both as a folder and as an object.
    let mut exact_key: Option<String> = None;
    let mut exact_folder: Option<String> = None;
    if let Some(path) = parsed.exact_path.clone() {
        let prefix = if path.ends_with('/') { path.clone() } else { format!("{path}/") };
        match client.list_objects_v2().bucket(bucket).prefix(&prefix).max_keys(1).send().await {
            Ok(page) if page.key_count().unwrap_or(0) > 0 || !page.contents().is_empty() => {
                exact.push(folder_hit(&prefix, true));
                exact_folder = Some(prefix);
            }
            Ok(_) => {}
            Err(e) => {
                let e = AppError::from(e);
                if exact_check_fails(&e) {
                    return Err(e);
                }
            }
        }
        // A folder marker is never an exact object hit (the scan skips markers as objects too).
        if !path.ends_with('/') {
            match crate::ops::head_object(client, bucket, &path).await {
                Ok(m) => {
                    let entry = ObjectEntry {
                        key: m.key,
                        name: m.name,
                        size: m.size,
                        last_modified: m.last_modified,
                        etag: m.etag,
                        storage_class: m.storage_class,
                    };
                    exact.push(object_hit(entry, None, true));
                    exact_key = Some(path.clone());
                }
                Err(e) if !exact_check_fails(&e) => {}
                Err(e) => return Err(e),
            }
        }
    }

    let lookups = AtomicU64::new(0);
    // Memory bound: matched folders are kept only up to `limit` (every hit counts toward it), and
    // de-duplication needs only the previous key (see `new_folders`), so nothing grows with the
    // number of folders in the bucket.
    let mut folders: Vec<String> = Vec::new();
    let mut objects: Vec<SearchHit> = Vec::new();
    // The exact hits alone can fill the limit: then nothing is listed.
    let filled = (exact.len() >= limit).then_some(Stop::Limit(limit));
    let mut scanned: u64;
    let mut stop: Option<Stop>;
    let mut truncated: bool;
    loop {
        let prefix = parsed.list_prefix.clone();
        scanned = 0;
        let mut listed: u64 = 0;
        stop = filled;
        truncated = stop.is_some();
        folders.clear();
        objects.clear();
        let mut prev_key: Option<String> = None;
        let mut token: Option<String> = None;
        let mut seen: HashSet<String> = HashSet::new();
        let mut pages: u64 = 0;
        let total = |folders: &Vec<String>, objects: &Vec<SearchHit>| exact.len() + folders.len() + objects.len();

        while stop.is_none() {
            let page = client
                .list_objects_v2()
                .bucket(bucket)
                .prefix(prefix.as_str())
                .set_continuation_token(token.clone())
                .send()
                .await?;
            pages += 1;
            // Keys of this page (or candidates) that a cap kept from being looked at.
            let mut left_over = false;
            let mut candidates: Vec<ObjectEntry> = Vec::new();
            for o in page.contents() {
                let Some(key) = o.key() else { continue };
                if stop.is_some() {
                    left_over = true;
                    break;
                }
                let marker = key.ends_with('/');
                if !marker && scanned >= SEARCH_MAX_SCAN {
                    stop = Some(Stop::Scan);
                    left_over = true;
                    break;
                }
                listed += 1;
                // Folders (never with tag terms: folders have no tags).
                if !with_tags && key.starts_with(prefix.as_str()) {
                    for f in new_folders(key, prev_key.as_deref(), prefix.len()) {
                        if exact_folder.as_deref() != Some(f) && matches(&parsed, &f.to_lowercase()) {
                            folders.push(f.to_string());
                            if total(&folders, &objects) >= limit {
                                stop = Some(Stop::Limit(limit));
                                break;
                            }
                        }
                    }
                }
                prev_key = Some(key.to_string());
                // A key ending in '/' is a folder marker, not a file: not an object, not counted.
                if marker {
                    continue;
                }
                if stop.is_some() {
                    // The limit was reached by this key's folders; the key itself was not looked at.
                    left_over = true;
                    break;
                }
                scanned += 1;
                if exact_key.as_deref() == Some(key) || !matches(&parsed, &key.to_lowercase()) {
                    continue;
                }
                if with_tags {
                    candidates.push(object_entry(o, key));
                } else {
                    objects.push(object_hit(object_entry(o, key), None, false));
                    if total(&folders, &objects) >= limit {
                        stop = Some(Stop::Limit(limit));
                    }
                }
            }

            if with_tags && !candidates.is_empty() {
                let room = (SEARCH_MAX_TAG_LOOKUPS - lookups.load(Ordering::Relaxed)) as usize;
                let over_cap = candidates.len() > room;
                let todo: Vec<ObjectEntry> = candidates.into_iter().take(room).collect();
                let todo_len = todo.len();
                let first_ever = lookups.load(Ordering::Relaxed) == 0;
                let lookups_ref = &lookups;
                let mut results = stream::iter(todo.into_iter().map(|entry| async move {
                    lookups_ref.fetch_add(1, Ordering::Relaxed);
                    let r = crate::tags::get_object_tags(client, bucket, &entry.key).await;
                    (entry, r)
                }))
                .buffered(SEARCH_TAG_PARALLELISM);
                let mut consumed = 0usize;
                let mut limit_hit = false;
                while let Some((entry, r)) = results.next().await {
                    consumed += 1;
                    match r {
                        Ok(tags) => {
                            if tags_match(&parsed.tags, &tags) {
                                objects.push(object_hit(entry, Some(tags), false));
                                if total(&folders, &objects) >= limit {
                                    limit_hit = true;
                                    break;
                                }
                            }
                        }
                        // Deleted since the listing.
                        Err(e) if e.code == ErrorCode::NoSuchKey => {}
                        Err(e) if e.code == ErrorCode::AccessDenied && first_ever && consumed == 1 => {
                            return Err(AppError::new(ErrorCode::AccessDenied, format!("{TAG_PERMISSION} ({})", e.message)));
                        }
                        Err(e) => return Err(e),
                    }
                }
                drop(results);
                if limit_hit {
                    stop = Some(Stop::Limit(limit));
                    left_over |= consumed < todo_len || over_cap;
                } else if over_cap {
                    stop = Some(Stop::Tags);
                    left_over = true;
                }
            }

            match next_list_page(page.is_truncated(), page.next_continuation_token(), |t| seen.contains(t)) {
                NextPage::Done => {
                    truncated = stop.is_some() && left_over;
                    break;
                }
                // More pages exist, so stopping here is a truncated result, never a complete one.
                NextPage::Continue(_) if stop.is_some() => {
                    truncated = true;
                    break;
                }
                // Bound by pages too: a listing of folder markers scans nothing but never ends.
                NextPage::Continue(_) if pages >= SEARCH_MAX_PAGES => {
                    stop = Some(Stop::Pages);
                    truncated = true;
                    break;
                }
                NextPage::Continue(t) => {
                    seen.insert(t.clone());
                    token = Some(t);
                }
                // Stopped anyway; the rest of the listing is unknown, so the result is truncated.
                NextPage::Error(_) if stop.is_some() => {
                    truncated = true;
                    break;
                }
                NextPage::Error(why) => return Err(listing_error(bucket, &prefix, why)),
            }
        }

        // Narrowing fallback: prefixes are case-sensitive, so a narrowed listing that held no keys at
        // all (not even a folder marker) is listed again from the scope (the path term still matches
        // as a case-insensitive word). A narrowed listing that had keys but no hits is final, and so
        // is one stopped by a cap such as the page bound.
        if stop.is_none() && listed == 0 && parsed.list_prefix.len() > q.scope.len() {
            parsed.list_prefix = q.scope.clone();
            continue;
        }
        break;
    }

    // Prefix order; the listing order already gives it, sorting also covers a server that does not.
    folders.sort();
    folders.dedup();
    let mut hits = exact;
    hits.extend(folders.iter().map(|f| folder_hit(f, false)));
    hits.extend(objects);
    Ok(SearchResult {
        hits,
        scanned,
        tag_lookups: lookups.load(Ordering::Relaxed),
        truncated,
        reason: if truncated { stop.map(Stop::reason) } else { None },
        parsed,
    })
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Running searches by caller-supplied id: a newer search with the same id cancels the older,
/// which then ends `Cancelled` (same rule as `preview_batch`'s `previewId`).
#[derive(Default)]
pub struct SearchRegistry {
    /// id -> (generation, token). The generation tells a search's own entry from a newer one.
    running: Mutex<HashMap<String, (u64, CancellationToken)>>,
    next: AtomicU64,
}

impl SearchRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Takes `id` over (cancelling the search that held it) and returns this search's entry.
    fn register(&self, id: &str) -> (u64, CancellationToken) {
        let entry = (self.next.fetch_add(1, Ordering::Relaxed), CancellationToken::new());
        let mut running = lock(&self.running);
        if let Some((_, old)) = running.insert(id.to_string(), entry.clone()) {
            old.cancel();
        }
        entry
    }

    /// Forgets `id` only when the entry is still this search's own (`generation`), checked under
    /// the lock: a search that finishes never removes a newer search's entry.
    fn finish(&self, id: &str, generation: u64) {
        let mut running = lock(&self.running);
        if running.get(id).is_some_and(|(g, _)| *g == generation) {
            running.remove(id);
        }
    }

    /// Runs `fut` under `id`; it is dropped (and the call returns `Cancelled`) as soon as a newer
    /// call takes the id over, [`Self::cancel`] names it or [`Self::cancel_all`] runs.
    pub async fn run<T>(&self, id: &str, fut: impl Future<Output = AppResult<T>>) -> AppResult<T> {
        let (generation, token) = self.register(id);
        let r = tokio::select! {
            biased;
            _ = token.cancelled() => Err(AppError::cancelled()),
            r = fut => r,
        };
        self.finish(id, generation);
        r
    }

    /// `cancel_search`: cancels the running search with this id (it ends `Cancelled`); a no-op
    /// when none is running.
    pub fn cancel(&self, id: &str) {
        if let Some((_, t)) = lock(&self.running).remove(id) {
            t.cancel();
        }
    }

    /// Cancels every running search (disconnect, or a new connection).
    pub fn cancel_all(&self) {
        for (_, (_, t)) in lock(&self.running).drain() {
            t.cancel();
        }
    }

    /// How many searches are running.
    pub fn running(&self) -> usize {
        lock(&self.running).len()
    }
}

/// `search_objects`: everything, validation included, runs under `id`, so even a call that fails
/// validation first cancels an older search with the same id. `client` resolves the bucket's
/// client (also cancellable).
pub async fn run_search<F, Fut>(reg: &SearchRegistry, id: &str, q: &SearchQuery, client: F) -> AppResult<SearchResult>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = AppResult<Client>>,
{
    reg.run(id, async {
        prepare(q)?;
        let c = client().await?;
        search(&c, q).await
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{FakeS3, Reply};

    fn p(text: &str) -> ParsedSearch {
        parse(text).search
    }

    fn strs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn words_phrases_and_exclusions() {
        let s = p("  Invoice  2026\t");
        assert_eq!(s.words, strs(&["invoice", "2026"]));
        assert!(s.phrases.is_empty() && s.excluded.is_empty() && s.tags.is_empty());
        assert_eq!(s.exact_path, None);

        let s = p(r#"report "Two  Words" -Draft -"old Copy" x"#);
        assert_eq!(s.words, strs(&["report", "x"]));
        assert_eq!(s.phrases, strs(&["two  words"]), "inner whitespace kept");
        assert_eq!(s.excluded, strs(&["draft", "old copy"]));
    }

    #[test]
    fn unterminated_and_empty_quotes() {
        let s = p(r#"a "rest of the Text"#);
        assert_eq!(s.words, strs(&["a"]));
        assert_eq!(s.phrases, strs(&["rest of the text"]));
        let s = p(r#"-"never closed"#);
        assert_eq!(s.excluded, strs(&["never closed"]));
        assert!(p(r#""" -"""#).is_empty(), "empty phrases are not terms");
        assert!(p("   ").is_empty());
        assert!(p("").is_empty());
    }

    #[test]
    fn a_lone_dash_is_a_word() {
        let s = p("-");
        assert_eq!(s.words, strs(&["-"]));
        let s = p("--x");
        assert_eq!(s.excluded, strs(&["-x"]));
    }

    #[test]
    fn tag_terms() {
        let s = p("tag:Env=Prod tag:owner TAG:k= tag:a=b=c");
        assert_eq!(
            s.tags,
            vec![
                SearchTagTerm { key: "Env".into(), value: Some("Prod".into()) },
                SearchTagTerm { key: "owner".into(), value: None },
                SearchTagTerm { key: "k".into(), value: Some(String::new()) },
                SearchTagTerm { key: "a".into(), value: Some("b=c".into()) },
            ]
        );
        assert!(s.words.is_empty());
        // No key: an ordinary word.
        let s = p("tag: tag:=x");
        assert!(s.tags.is_empty());
        assert_eq!(s.words, strs(&["tag:", "tag:=x"]));
        // A tag term with a slash is a tag, not a path term.
        let parsed = parse("tag:a/b=c");
        assert_eq!(parsed.search.tags.len(), 1);
        assert!(parsed.path_terms.is_empty() && parsed.search.exact_path.is_none());
    }

    #[test]
    fn path_terms_and_exact_path() {
        let parsed = parse("Photos/2024/IMG_01.jpg");
        assert_eq!(parsed.search.words, strs(&["photos/2024/img_01.jpg"]));
        assert_eq!(parsed.path_terms, strs(&["Photos/2024/IMG_01.jpg"]), "case kept for the listing");
        assert_eq!(parsed.search.exact_path.as_deref(), Some("Photos/2024/IMG_01.jpg"), "byte-for-byte as typed");

        // Keys are opaque: no normalization of the typed path.
        let parsed = parse("a//b/../c\\d ");
        assert_eq!(parsed.search.exact_path.as_deref(), Some("a//b/../c\\d"));

        // Not the whole query: no exact path.
        let parsed = parse("photos/2024 cat");
        assert_eq!(parsed.search.exact_path, None);
        assert_eq!(parsed.path_terms, strs(&["photos/2024"]));
        // Quoted: a phrase, not a path term.
        let parsed = parse(r#""photos/2024""#);
        assert_eq!(parsed.search.exact_path, None);
        assert!(parsed.path_terms.is_empty());
        assert_eq!(parsed.search.phrases, strs(&["photos/2024"]));
        // Excluded: not a path term.
        let parsed = parse("-photos/2024");
        assert!(parsed.path_terms.is_empty() && parsed.search.exact_path.is_none());
        // Without a slash: a word.
        assert_eq!(parse("photos").search.exact_path, None);
    }

    #[test]
    fn non_ascii_is_lowercased() {
        let s = p(r#"ÄRGER "Größe ÜBER" -ÉTÉ Ωmega/Ζ"#);
        assert_eq!(s.words, strs(&["ärger", "ωmega/ζ"]));
        assert_eq!(s.phrases, strs(&["größe über"]));
        assert_eq!(s.excluded, strs(&["été"]));
    }

    #[test]
    fn matcher() {
        let s = p(r#"invoice 2026 "q1 final" -draft"#);
        assert!(matches(&s, &"billing/2026/Invoice Q1 FINAL.pdf".to_lowercase()));
        assert!(!matches(&s, &"billing/2026/invoice q1 final draft.pdf".to_lowercase()), "excluded");
        assert!(!matches(&s, &"billing/2025/invoice q1 final.pdf".to_lowercase()), "AND");
        assert!(!matches(&s, &"billing/2026/invoice q1-final.pdf".to_lowercase()), "phrase needs the space");
        // Matching is against the full key, not a display name.
        let s = p("billing invoice");
        assert!(matches(&s, "billing/2026/invoice-0412.pdf"));
        // Only exclusions: everything else matches.
        let s = p("-tmp");
        assert!(matches(&s, "a/b.txt") && !matches(&s, "a/tmp/b.txt"));
        // Non-ASCII on both sides.
        let s = p("GRÖSSE");
        assert!(matches(&s, &"docs/Grösse.txt".to_lowercase()));
    }

    #[test]
    fn tag_matcher() {
        let terms = p("tag:Env=prod tag:owner").tags;
        let t = |k: &str, v: &str| Tag::new(k, v);
        assert!(tags_match(&terms, &[t("Env", "PROD"), t("owner", "")]));
        assert!(!tags_match(&terms, &[t("env", "prod"), t("owner", "x")]), "keys are case-sensitive");
        assert!(!tags_match(&terms, &[t("Env", "prod")]), "every term must match");
        assert!(!tags_match(&terms, &[t("Env", "production"), t("owner", "x")]), "exact value");
        assert!(tags_match(&[], &[]));
    }

    #[test]
    fn narrowing() {
        let pt = |v: &[&str]| strs(v);
        // The term's folder lies inside the scope: list it.
        assert_eq!(list_prefix("", &pt(&["photos/2024/img"])), "photos/2024/");
        assert_eq!(list_prefix("photos/", &pt(&["photos/2024/img"])), "photos/2024/");
        assert_eq!(list_prefix("photos/", &pt(&["photos/"])), "photos/");
        // The scope lies inside the term's folder: keep the scope.
        assert_eq!(list_prefix("photos/2024/raw/", &pt(&["photos/x"])), "photos/2024/raw/");
        // Unrelated: keep the scope (the term still matches as a word).
        assert_eq!(list_prefix("docs/", &pt(&["photos/2024/img"])), "docs/");
        // No path term.
        assert_eq!(list_prefix("docs/", &[]), "docs/");
        // Several path terms: the longest qualifying folder.
        assert_eq!(list_prefix("", &pt(&["a/b", "a/b/c/d", "zz/q"])), "a/b/c/");
        assert_eq!(list_prefix("a/", &pt(&["a/b/c/d", "zz/yy/xx/ww/q"])), "a/b/c/", "a longer unrelated folder does not qualify");
        // Case and odd keys are kept as typed.
        assert_eq!(list_prefix("", &pt(&["A//b/../x"])), "A//b/../");
        assert_eq!(list_prefix("", &pt(&["/lead"])), "/");
    }

    #[test]
    fn prepare_validates() {
        let q = |text: &str, limit: i64| SearchQuery { bucket: "b".into(), scope: "".into(), text: text.into(), limit };
        assert_eq!(prepare(&q("", 10)).map(|_| ()).unwrap_err().code, ErrorCode::InvalidInput);
        assert_eq!(prepare(&q(r#""""#, 10)).map(|_| ()).unwrap_err().message, EMPTY_QUERY);
        for bad in [0, -1, 1001] {
            assert_eq!(prepare(&q("x", bad)).map(|_| ()).unwrap_err().code, ErrorCode::InvalidInput, "{bad}");
        }
        assert!(prepare(&q("x", 1)).is_ok() && prepare(&q("x", 1000)).is_ok());
        let parsed = prepare(&SearchQuery { bucket: "b".into(), scope: "a/".into(), text: "a/b/c".into(), limit: 5 }).expect("ok");
        assert_eq!(parsed.search.list_prefix, "a/b/");
    }

    #[test]
    fn reasons() {
        assert_eq!(Stop::Scan.reason(), "Stopped after scanning 50,000 objects");
        assert_eq!(Stop::Tags.reason(), "Stopped after 2,000 tag lookups");
        assert_eq!(Stop::Limit(500).reason(), "Stopped at 500 results");
        assert_eq!(Stop::Limit(1).reason(), "Stopped at 1 result");
        assert_eq!(thousands(1_234_567), "1,234,567");
        assert_eq!(thousands(999), "999");
    }

    fn listing(keys: &[&str]) -> String {
        let mut x = String::from("<ListBucketResult><IsTruncated>false</IsTruncated>");
        for k in keys {
            x.push_str(&format!("<Contents><Key>{k}</Key><Size>1</Size></Contents>"));
        }
        x.push_str("</ListBucketResult>");
        x
    }

    fn query(text: &str) -> SearchQuery {
        SearchQuery { bucket: "b".into(), scope: "".into(), text: text.into(), limit: 100 }
    }

    #[tokio::test]
    async fn access_denied_on_the_first_tag_lookup_names_the_permission() {
        let fake = FakeS3::start(|r| {
            if r.has_query("tagging") {
                Reply::xml(403, "<Error><Code>AccessDenied</Code><Message>no</Message></Error>")
            } else {
                Reply::xml(200, &listing(&["a/x.txt", "a/y.txt"]))
            }
        })
        .await;
        let e = search(&fake.client(), &query("tag:env")).await.unwrap_err();
        assert_eq!(e.code, ErrorCode::AccessDenied);
        assert!(e.message.starts_with(TAG_PERMISSION) && e.message.contains("s3:GetObjectTagging"), "{}", e.message);
    }

    #[tokio::test]
    async fn a_deleted_candidate_is_dropped_and_folder_markers_are_skipped() {
        let fake = FakeS3::start(|r| {
            if r.has_query("tagging") {
                if r.path.ends_with("gone.txt") {
                    Reply::xml(404, "<Error><Code>NoSuchKey</Code><Message>gone</Message></Error>")
                } else {
                    Reply::xml(200, "<Tagging><TagSet><Tag><Key>env</Key><Value>Prod</Value></Tag></TagSet></Tagging>")
                }
            } else {
                Reply::xml(200, &listing(&["a/", "a/gone.txt", "a/kept.txt"]))
            }
        })
        .await;
        let r = search(&fake.client(), &query("tag:env=prod")).await.expect("search");
        let keys: Vec<&str> = keys_of(&r);
        assert_eq!(keys, ["a/kept.txt"]);
        assert_eq!((r.scanned, r.tag_lookups, r.truncated), (2, 2, false));
        assert_eq!(r.hits[0].tags.as_ref().map(|t| t.len()), Some(1));
    }

    #[tokio::test]
    async fn a_repeated_continuation_token_is_an_error() {
        let fake = FakeS3::start(|_| {
            Reply::xml(
                200,
                "<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t1</NextContinuationToken><Contents><Key>k</Key><Size>1</Size></Contents></ListBucketResult>",
            )
        })
        .await;
        let e = search(&fake.client(), &query("zzz")).await.unwrap_err();
        assert!(e.message.contains("same continuation token"), "{}", e.message);
    }

    #[tokio::test]
    async fn limit_stops_and_reports_truncation_only_when_more_remain() {
        let fake = FakeS3::start(|_| Reply::xml(200, &listing(&["k1", "k2", "k3"]))).await;
        let mut q = query("k");
        q.limit = 2;
        let r = search(&fake.client(), &q).await.expect("search");
        assert_eq!((r.hits.len(), r.truncated, r.reason.as_deref()), (2, true, Some("Stopped at 2 results")));
        q.limit = 3;
        let r = search(&fake.client(), &q).await.expect("search");
        assert_eq!((r.hits.len(), r.truncated, r.reason), (3, false, None), "the limit reached on the last key is complete");
    }

    /// A fake bucket of `n` keys `k00000..`, listed 1,000 per page (token = page number).
    fn paged(n: usize) -> impl Fn(&crate::testutil::Req) -> Reply + Send + Sync + 'static {
        move |r| {
            if r.has_query("tagging") {
                return Reply::xml(200, "<Tagging><TagSet><Tag><Key>env</Key><Value>x</Value></Tag></TagSet></Tagging>");
            }
            let page: usize = r
                .query
                .split('&')
                .find_map(|p| p.strip_prefix("continuation-token="))
                .and_then(|t| t.parse().ok())
                .unwrap_or(0);
            let (from, to) = (page * 1000, ((page + 1) * 1000).min(n));
            let more = to < n;
            let mut x = format!("<ListBucketResult><IsTruncated>{more}</IsTruncated>");
            if more {
                x.push_str(&format!("<NextContinuationToken>{}</NextContinuationToken>", page + 1));
            }
            for i in from..to {
                x.push_str(&format!("<Contents><Key>k{i:05}</Key><Size>1</Size></Contents>"));
            }
            x.push_str("</ListBucketResult>");
            Reply::xml(200, &x)
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_scan_stops_at_50000_keys() {
        let fake = FakeS3::start(paged(50_001)).await;
        let r = search(&fake.client(), &query("nomatch")).await.expect("search");
        assert_eq!((r.scanned, r.truncated), (SEARCH_MAX_SCAN, true));
        assert_eq!(r.reason.as_deref(), Some("Stopped after scanning 50,000 objects"));
        // Exactly 50,000 keys: complete.
        let fake = FakeS3::start(paged(50_000)).await;
        let r = search(&fake.client(), &query("nomatch")).await.expect("search");
        assert_eq!((r.scanned, r.truncated, r.reason), (SEARCH_MAX_SCAN, false, None));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn tag_lookups_stop_at_2000() {
        let fake = FakeS3::start(paged(2_500)).await;
        let r = search(&fake.client(), &query("tag:other")).await.expect("search");
        assert_eq!((r.tag_lookups, r.truncated), (SEARCH_MAX_TAG_LOOKUPS, true));
        assert_eq!(r.reason.as_deref(), Some("Stopped after 2,000 tag lookups"));
        assert!(r.hits.is_empty());
        assert_eq!(fake.count(|q| q.has_query("tagging")), 2_000);
    }

    /// A listing per prefix: `Photos/` (typed case) holds nothing, `photos/` holds the keys,
    /// `docs/` holds keys that do not match.
    fn by_prefix(r: &crate::testutil::Req) -> Reply {
        let prefix = r.query.split('&').find_map(|p| p.strip_prefix("prefix=")).unwrap_or("");
        match prefix {
            "Photos%2F2024%2F" => Reply::xml(200, &listing(&[])),
            "docs%2Fq%2F" => Reply::xml(200, &listing(&["docs/q/other.txt"])),
            _ => Reply::xml(200, &listing(&["docs/q/other.txt", "photos/2024/a.jpg", "photos/2024/b.jpg", "x.txt"])),
        }
    }

    #[tokio::test]
    async fn an_empty_narrowed_listing_falls_back_to_the_scope() {
        let fake = FakeS3::start(by_prefix).await;
        let r = search(&fake.client(), &query("Photos/2024/ jpg")).await.expect("search");
        assert_eq!(keys_of(&r), ["photos/2024/a.jpg", "photos/2024/b.jpg"]);
        assert_eq!(r.parsed.list_prefix, "", "reports the scope");
        assert_eq!(r.scanned, 4, "counts only the second scan");
        let lists: Vec<String> = fake.requests().iter().filter(|q| q.has_query("list-type")).map(|q| q.query.clone()).collect();
        assert_eq!(lists.len(), 2, "{lists:?}");
        assert!(lists[0].contains("prefix=Photos%2F2024%2F") && !lists[1].contains("Photos"), "{lists:?}");
    }

    #[tokio::test]
    async fn a_narrowed_listing_with_keys_but_no_hits_is_final() {
        let fake = FakeS3::start(by_prefix).await;
        let r = search(&fake.client(), &query("docs/q/ zzz")).await.expect("search");
        assert!(r.hits.is_empty());
        assert_eq!((r.parsed.list_prefix.as_str(), r.scanned), ("docs/q/", 1));
        assert_eq!(fake.count(|q| q.has_query("list-type")), 1, "no second scan");
        // Not narrowed (the scope itself is empty): no retry either.
        let fake = FakeS3::start(|_| Reply::xml(200, &listing(&[]))).await;
        let r = search(&fake.client(), &query("anything")).await.expect("search");
        assert_eq!((r.scanned, r.hits.len()), (0, 0));
        assert_eq!(fake.count(|q| q.has_query("list-type")), 1);
    }

    fn keys_of(r: &SearchResult) -> Vec<&str> {
        r.hits.iter().map(|h| h.entry.as_ref().map(|e| e.key.as_str()).or(h.folder.as_ref().map(|f| f.prefix.as_str())).unwrap_or("")).collect()
    }

    #[tokio::test]
    async fn cancel_search_cancels_only_that_id() {
        let reg = std::sync::Arc::new(SearchRegistry::new());
        reg.cancel("nothing-running"); // a no-op
        let (a, b) = (reg.clone(), reg.clone());
        let one = tokio::spawn(async move { a.run("one", std::future::pending::<AppResult<u32>>()).await });
        let two = tokio::spawn(async move { b.run("two", std::future::pending::<AppResult<u32>>()).await });
        while reg.running() < 2 {
            tokio::task::yield_now().await;
        }
        reg.cancel("one");
        assert!(one.await.expect("join").unwrap_err().is_cancelled());
        assert_eq!(reg.running(), 1);
        assert!(!two.is_finished());
        reg.cancel("two");
        assert!(two.await.expect("join").unwrap_err().is_cancelled());
        assert_eq!(reg.running(), 0);
    }

    #[test]
    fn quotes_group_inside_a_term() {
        let s = p(r#"tag:Project="Big Data" x"#);
        assert_eq!(s.tags, vec![SearchTagTerm { key: "Project".into(), value: Some("Big Data".into()) }]);
        assert_eq!(s.words, strs(&["x"]));
        let s = p(r#"tag:"My Key"=v"#);
        assert_eq!(s.tags, vec![SearchTagTerm { key: "My Key".into(), value: Some("v".into()) }]);
        // Any other term with a quote is a phrase, quotes dropped.
        let s = p(r#"foo"bar baz" q"#);
        assert_eq!(s.phrases, strs(&["foobar baz"]));
        assert_eq!(s.words, strs(&["q"]));
        let s = p(r#""a b"c"#);
        assert_eq!(s.phrases, strs(&["a bc"]));
        assert!(s.words.is_empty());
        let s = p(r#"-"x y"z"#);
        assert_eq!(s.excluded, strs(&["x yz"]));
        let s = p(r#"-no"t this""#);
        assert_eq!(s.excluded, strs(&["not this"]));
        // An unterminated quote inside a term runs to the end of the text.
        let s = p(r#"tag:k="a b c"#);
        assert_eq!(s.tags, vec![SearchTagTerm { key: "k".into(), value: Some("a b c".into()) }]);
        // A quoted "/" term is not a path term.
        let parsed = parse(r#"a"/"b"#);
        assert!(parsed.path_terms.is_empty() && parsed.search.exact_path.is_none());
        assert_eq!(parsed.search.phrases, strs(&["a/b"]));
        // A quoted prefix is not a prefix.
        let s = p(r#""tag:k" "-x""#);
        assert!(s.tags.is_empty() && s.excluded.is_empty());
        assert_eq!(s.phrases, strs(&["tag:k", "-x"]));
    }

    #[test]
    fn prefixes_are_checked_as_typed() {
        // `tag:` before quotes are removed: a fully quoted "tag:x" is a phrase.
        let s = p(r#""tag:x""#);
        assert!(s.tags.is_empty());
        assert_eq!(s.phrases, strs(&["tag:x"]));
        let s = p("TAG:k=v");
        assert_eq!(s.tags, vec![SearchTagTerm { key: "k".into(), value: Some("v".into()) }]);
        // A leading `-` is decided first: `-TAG:k` excludes the text "tag:k".
        let s = p("-TAG:k");
        assert!(s.tags.is_empty());
        assert_eq!(s.excluded, strs(&["tag:k"]));
    }

    #[test]
    fn prefixes_are_case_insensitive_and_whitespace_is_unicode() {
        let s = p("TAG:k Tag:Env=Prod");
        assert_eq!(s.tags.len(), 2);
        assert_eq!(s.tags[0], SearchTagTerm { key: "k".into(), value: None });
        // U+00A0 (no-break space), U+3000 (ideographic space), U+2003 (em space) separate terms.
        let s = p("a\u{a0}b\u{3000}c\u{2003}d");
        assert_eq!(s.words, strs(&["a", "b", "c", "d"]));
    }

    #[test]
    fn empty_phrases_are_dropped_first() {
        let parsed = parse(r#"a/b """#);
        assert_eq!(parsed.search.exact_path.as_deref(), Some("a/b"), "the empty phrase does not count as a term");
        let parsed = parse(r#"-"" a/b"#);
        assert_eq!(parsed.search.exact_path.as_deref(), Some("a/b"));
        assert!(parsed.search.excluded.is_empty());
    }

    #[tokio::test]
    async fn exact_head_errors_other_than_network_auth_and_bucket_mean_no_exact_hit() {
        for status in [400u16, 301, 403, 404, 412] {
            let fake = FakeS3::start(move |r| {
                if r.method == "HEAD" || r.query.contains("max-keys=1") {
                    Reply::status(status)
                } else {
                    Reply::xml(200, &listing(&["a/b/c.txt", "a/b/c.txt.bak"]))
                }
            })
            .await;
            let r = search(&fake.client(), &query("a/b/c.txt")).await.unwrap_or_else(|e| panic!("{status}: {e:?}"));
            assert_eq!(keys_of(&r), ["a/b/c.txt", "a/b/c.txt.bak"], "{status}: the scan still runs");
            assert!(r.hits.iter().all(|h| !h.exact), "{status}");
        }
        // A broken bucket fails the search.
        let fake = FakeS3::start(|r| match r.method.as_str() {
            "HEAD" => Reply::status(404),
            _ => Reply::xml(404, "<Error><Code>NoSuchBucket</Code><Message>m</Message></Error>"),
        })
        .await;
        assert_eq!(search(&fake.client(), &query("a/b")).await.unwrap_err().code, ErrorCode::NoSuchBucket);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_listing_stops_after_200_pages() {
        // A listing of folder markers only, never ending.
        let fake = FakeS3::start(|r| {
            let page: usize = r
                .query
                .split('&')
                .find_map(|p| p.strip_prefix("continuation-token="))
                .and_then(|t| t.parse().ok())
                .unwrap_or(0);
            Reply::xml(
                200,
                &format!(
                    "<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>{}</NextContinuationToken><Contents><Key>m{page}/</Key><Size>0</Size></Contents></ListBucketResult>",
                    page + 1
                ),
            )
        })
        .await;
        let r = search(&fake.client(), &query("x")).await.expect("search");
        assert_eq!((r.scanned, r.truncated), (0, true));
        assert_eq!(r.reason.as_deref(), Some("Stopped after listing 200 pages"));
        assert_eq!(fake.count(|q| q.has_query("list-type")), 200);
        // A narrowed listing stopped by the bound is not retried from the scope.
        let r = search(&fake.client(), &query("m/x")).await.expect("search");
        assert_eq!((r.parsed.list_prefix.as_str(), r.truncated), ("m/", true));
        assert_eq!(fake.count(|q| q.has_query("list-type")), 401, "200 pages plus the exact-folder check");
    }

    /// The race: search A decided to forget its id, then B took the id over, then A removed it.
    /// The removal is keyed to A's own entry, so B stays registered (and cancellable).
    #[test]
    fn a_finishing_search_never_removes_a_newer_entry() {
        let reg = SearchRegistry::new();
        let (a_gen, a_token) = reg.register("s");
        // B's entry lands without A's token being cancelled yet (A already passed its check).
        let b = (reg.next.fetch_add(1, Ordering::Relaxed), CancellationToken::new());
        lock(&reg.running).insert("s".into(), b.clone());
        assert!(!a_token.is_cancelled());
        reg.finish("s", a_gen);
        assert_eq!(reg.running(), 1, "B's entry survives A finishing");
        reg.cancel("s");
        assert!(b.1.is_cancelled(), "B can still be cancelled");
        // And A finishing on its own entry forgets it.
        let (g, _) = reg.register("t");
        reg.finish("t", g);
        assert_eq!(reg.running(), 0);
    }

    #[tokio::test]
    async fn a_call_that_fails_validation_still_cancels_the_older_search() {
        let reg = std::sync::Arc::new(SearchRegistry::new());
        let r1 = reg.clone();
        let older = tokio::spawn(async move { r1.run("box", std::future::pending::<AppResult<SearchResult>>()).await });
        while reg.running() == 0 {
            tokio::task::yield_now().await;
        }
        let bad = query("  ");
        let never = || async { Err::<Client, _>(AppError::new(ErrorCode::Unknown, "client must not be asked for")) };
        let e = run_search(&reg, "box", &bad, never).await.unwrap_err();
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, EMPTY_QUERY));
        assert!(older.await.expect("join").unwrap_err().is_cancelled());
        let mut bad_limit = query("x");
        bad_limit.limit = 0;
        assert_eq!(run_search(&reg, "box", &bad_limit, never).await.unwrap_err().code, ErrorCode::InvalidInput);
        assert_eq!(reg.running(), 0);
    }

    fn decode(s: &str) -> String {
        let b = s.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'%' && i + 2 < b.len() {
                out.push(u8::from_str_radix(&s[i + 1..i + 3], 16).expect("hex"));
                i += 3;
            } else {
                out.push(b[i]);
                i += 1;
            }
        }
        String::from_utf8(out).expect("utf8")
    }

    fn param(r: &crate::testutil::Req, name: &str) -> Option<String> {
        r.query.split('&').find_map(|p| p.strip_prefix(&format!("{name}="))).map(decode)
    }

    /// A small bucket honouring `prefix` and `max-keys`, HEAD and (with `tags`) GetObjectTagging.
    fn bucket(keys: &'static [&'static str]) -> impl Fn(&crate::testutil::Req) -> Reply + Send + Sync + 'static {
        move |r| {
            let key = decode(r.path.trim_start_matches("/b/"));
            if r.method == "HEAD" {
                return if keys.contains(&key.as_str()) {
                    Reply::with_headers(200, vec![crate::testutil::h("Content-Length", "3"), crate::testutil::h("ETag", "\"e\"")])
                } else {
                    Reply::status(404)
                };
            }
            if r.has_query("tagging") {
                return Reply::xml(200, "<Tagging><TagSet><Tag><Key>k</Key><Value>v</Value></Tag></TagSet></Tagging>");
            }
            let prefix = param(r, "prefix").unwrap_or_default();
            let max: usize = param(r, "max-keys").and_then(|m| m.parse().ok()).unwrap_or(1000);
            let listed: Vec<&str> = keys.iter().copied().filter(|k| k.starts_with(prefix.as_str())).take(max).collect();
            Reply::xml(200, &listing(&listed))
        }
    }

    const TREE: &[&str] = &["a/", "a/b/1.txt", "a/b/2.txt", "a/c/x/3.txt", "b/report/4.txt", "z.txt"];

    #[test]
    fn new_folders_uses_the_previous_key_for_dedup() {
        let all: Vec<&str> = new_folders("a/b/c/d.txt", None, 0).collect();
        assert_eq!(all, ["a/", "a/b/", "a/b/c/"]);
        let below: Vec<&str> = new_folders("a/b/c/d.txt", None, 2).collect();
        assert_eq!(below, ["a/b/", "a/b/c/"], "only strictly below the listed prefix");
        let fresh: Vec<&str> = new_folders("a/b/x/e.txt", Some("a/b/c/d.txt"), 0).collect();
        assert_eq!(fresh, ["a/b/x/"]);
        let marker: Vec<&str> = new_folders("a/m/", Some("a/b/x/e.txt"), 0).collect();
        assert_eq!(marker, ["a/m/"], "a folder marker is its own folder");
        assert_eq!(new_folders("plain.txt", None, 0).count(), 0);
        // Byte slicing never splits a character.
        let uni: Vec<&str> = new_folders("ä/ö/ü.txt", None, 0).collect();
        assert_eq!(uni, ["ä/", "ä/ö/"]);
    }

    #[tokio::test]
    async fn folder_hits_are_derived_deduplicated_and_first() {
        let fake = FakeS3::start(bucket(TREE)).await;
        let r = search(&fake.client(), &query("b")).await.expect("search");
        assert_eq!(keys_of(&r), ["a/b/", "b/", "b/report/", "a/b/1.txt", "a/b/2.txt", "b/report/4.txt"]);
        let kinds: Vec<SearchHitKind> = r.hits.iter().map(|h| h.kind).collect();
        assert_eq!(&kinds[..3], [SearchHitKind::Folder; 3]);
        assert!(r.hits[..3].iter().all(|h| h.entry.is_none() && h.tags.is_none() && !h.exact));
        assert_eq!(r.hits[0].folder.as_ref().map(|f| f.name.as_str()), Some("b"));
        assert!(r.hits[3..].iter().all(|h| h.kind == SearchHitKind::Object && h.folder.is_none()));
        assert_eq!(r.scanned, 5, "the marker is not a scanned object");
        // Exclusions apply to folders as well (on the full prefix).
        let r = search(&fake.client(), &query("b -report")).await.expect("search");
        assert_eq!(keys_of(&r), ["a/b/", "b/", "a/b/1.txt", "a/b/2.txt"]);
        // A keyword that matches only a folder name.
        let r = search(&fake.client(), &query("x/")).await.expect("search");
        assert_eq!(keys_of(&r), ["a/c/x/", "a/c/x/3.txt"]);
    }

    #[tokio::test]
    async fn folders_count_toward_the_limit() {
        let fake = FakeS3::start(bucket(TREE)).await;
        let mut q = query("b");
        q.limit = 2;
        let r = search(&fake.client(), &q).await.expect("search");
        assert_eq!(keys_of(&r), ["a/b/", "a/b/1.txt"]);
        assert_eq!((r.truncated, r.reason.as_deref()), (true, Some("Stopped at 2 results")));
        q.limit = 1;
        let r = search(&fake.client(), &q).await.expect("search");
        assert_eq!(keys_of(&r), ["a/b/"]);
        assert!(r.truncated);
        q.limit = 7;
        let r = search(&fake.client(), &q).await.expect("search");
        assert_eq!((r.hits.len(), r.truncated), (6, false), "every hit, under the limit");
    }

    #[tokio::test]
    async fn no_folder_hits_with_tag_terms() {
        let fake = FakeS3::start(bucket(TREE)).await;
        let r = search(&fake.client(), &query("b tag:k")).await.expect("search");
        assert_eq!(keys_of(&r), ["a/b/1.txt", "a/b/2.txt", "b/report/4.txt"]);
        assert!(r.hits.iter().all(|h| h.kind == SearchHitKind::Object));
    }

    #[tokio::test]
    async fn exact_folder_with_and_without_a_trailing_slash() {
        let fake = FakeS3::start(bucket(TREE)).await;
        for text in ["a/b", "a/b/"] {
            let r = search(&fake.client(), &query(text)).await.expect("search");
            assert_eq!(keys_of(&r), ["a/b/", "a/b/1.txt", "a/b/2.txt"], "{text}");
            assert!(r.hits[0].exact && r.hits[0].kind == SearchHitKind::Folder, "{text}");
            assert!(r.hits[1..].iter().all(|h| !h.exact), "{text}");
        }
        assert_eq!(fake.count(|q| q.method == "HEAD"), 1, "a term ending in / is never headed");
        assert_eq!(fake.count(|q| q.query.contains("max-keys=1")), 2, "the folder check runs for both forms");
        // A prefix with nothing below it is not an exact folder.
        let r = search(&fake.client(), &query("a/q")).await.expect("search");
        assert!(r.hits.iter().all(|h| !h.exact));
    }

    #[tokio::test]
    async fn exact_object_and_exact_folder_both() {
        const KEYS: &[&str] = &["a/b", "a/b/1.txt"];
        let fake = FakeS3::start(bucket(KEYS)).await;
        let r = search(&fake.client(), &query("a/b")).await.expect("search");
        assert_eq!(keys_of(&r), ["a/b/", "a/b", "a/b/1.txt"]);
        assert_eq!((r.hits[0].kind, r.hits[0].exact), (SearchHitKind::Folder, true));
        assert_eq!((r.hits[1].kind, r.hits[1].exact), (SearchHitKind::Object, true));
        assert!(!r.hits[2].exact);
    }

    #[test]
    fn search_hit_kind_is_lowercase() {
        let h = folder_hit("a/b/", true);
        let v = serde_json::to_value(&h).expect("ser");
        assert_eq!(v["kind"], "folder");
        assert_eq!(v["folder"]["prefix"], "a/b/");
        assert!(v["entry"].is_null() && v["tags"].is_null());
        assert_eq!(serde_json::to_value(SearchHitKind::Object).expect("ser"), "object");
    }

    #[test]
    fn escaped_quotes_are_literal() {
        let parsed = parse(r#"path:"odd/say \"hi\".txt""#);
        assert_eq!(parsed.search.exact_path.as_deref(), Some(r#"odd/say "hi".txt"#));
        assert_eq!(parsed.path_terms, strs(&[r#"odd/say "hi".txt"#]));
        // `\"` does not toggle quoting and does not make a phrase.
        let s = p(r#"say\"hi there"#);
        assert_eq!(s.words, strs(&[r#"say"hi"#, "there"]));
        assert!(s.phrases.is_empty());
        let s = p(r#""a \" b" c"#);
        assert_eq!(s.phrases, strs(&[r#"a " b"#]));
        assert_eq!(s.words, strs(&["c"]));
        // Any other backslash stays as typed.
        let s = p(r"a\b C:\dir\ x\");
        assert_eq!(s.words, strs(&[r"a\b", r"c:\dir\", r"x\"]));
        let s = p(r#"-\"x"#);
        assert_eq!(s.excluded, strs(&[r#""x"#]));
    }

    #[test]
    fn path_prefix_terms() {
        let parsed = parse(r#"path:"docs/a b.txt""#);
        assert_eq!(parsed.search.exact_path.as_deref(), Some("docs/a b.txt"));
        assert_eq!(parsed.path_terms, strs(&["docs/a b.txt"]));
        assert_eq!(parsed.search.words, strs(&["docs/a b.txt"]));
        assert!(parsed.search.phrases.is_empty());
        assert_eq!(list_prefix("", &parsed.path_terms), "docs/");
        let q = SearchQuery { bucket: "b".into(), scope: "".into(), text: r#"path:"docs/a b.txt""#.into(), limit: 5 };
        assert_eq!(prepare(&q).expect("ok").search.list_prefix, "docs/");
        // Quotes group as usual: `path:x/y zzz` is a path term and a word.
        let parsed = parse("path:x/y zzz");
        assert_eq!(parsed.path_terms, strs(&["x/y"]));
        assert_eq!(parsed.search.words, strs(&["x/y", "zzz"]));
        assert_eq!(parsed.search.exact_path, None);
        let parsed = parse(r#"path:"a b/c.txt" "#);
        assert_eq!(parsed.search.exact_path.as_deref(), Some("a b/c.txt"));
        // Case-insensitive prefix; the value keeps its case.
        let parsed = parse(r#"PATH:"Q/r""#);
        assert_eq!((parsed.search.exact_path.as_deref(), parsed.search.words.clone()), (Some("Q/r"), strs(&["q/r"])));
        // An empty value is dropped (and does not count against the lone-term rule).
        assert!(p("path:").is_empty() && p(r#"path:"""#).is_empty());
        assert_eq!(parse("path: a/b").search.exact_path.as_deref(), Some("a/b"));
        // As typed: a fully quoted "path:x" is a phrase; `-path:x` an exclusion.
        assert_eq!(p(r#""path:x""#).phrases, strs(&["path:x"]));
        assert_eq!(p("-path:x").excluded, strs(&["path:x"]));
    }

    #[test]
    fn bridge_types_are_camel_case() {
        let r = SearchResult {
            hits: vec![],
            scanned: 1,
            tag_lookups: 2,
            truncated: false,
            reason: None,
            parsed: ParsedSearch { exact_path: Some("a/b".into()), list_prefix: "a/".into(), ..Default::default() },
        };
        let v = serde_json::to_value(&r).expect("ser");
        for f in ["hits", "scanned", "tagLookups", "truncated", "reason", "parsed"] {
            assert!(v.get(f).is_some(), "missing {f}");
        }
        for f in ["words", "phrases", "excluded", "tags", "exactPath", "listPrefix"] {
            assert!(v["parsed"].get(f).is_some(), "missing parsed.{f}");
        }
        let q: SearchQuery = serde_json::from_value(serde_json::json!({"bucket":"b","scope":"","text":"x","limit":500})).expect("de");
        assert_eq!(q.limit, 500);
    }

    #[tokio::test]
    async fn a_newer_search_with_the_same_id_cancels_the_older() {
        let reg = std::sync::Arc::new(SearchRegistry::new());
        let (r1, r2) = (reg.clone(), reg.clone());
        let older = tokio::spawn(async move { r1.run("s", std::future::pending::<AppResult<u32>>()).await });
        while reg.running() == 0 {
            tokio::task::yield_now().await;
        }
        let other = tokio::spawn({
            let r = reg.clone();
            async move { r.run("other", std::future::pending::<AppResult<u32>>()).await }
        });
        let newer = r2.run("s", async { Ok(7u32) }).await;
        assert_eq!(newer.expect("newer"), 7);
        assert!(older.await.expect("join").unwrap_err().is_cancelled());
        assert!(!other.is_finished(), "a different id keeps running");
        reg.cancel_all();
        assert!(other.await.expect("join").unwrap_err().is_cancelled());
        assert_eq!(reg.running(), 0);
    }
}
