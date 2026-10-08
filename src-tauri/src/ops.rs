//! Plain S3 operations (no Tauri dependency) used by the commands and the smoke test.

use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client;

use std::collections::HashSet;

use crate::error::{AppError, AppResult, ErrorCode};
use crate::models::{
    clean_etag, fmt_dt, last_segment, Bucket, FolderEntry, ListPage, ObjectEntry, ObjectMeta, RecentListing,
    RECENT_MAX_RESULTS, RECENT_SCAN_LIMIT,
};

pub async fn list_buckets(client: &Client) -> AppResult<Vec<Bucket>> {
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let resp = client.list_buckets().set_continuation_token(token.clone()).send().await?;
        out.extend(resp.buckets().iter().map(|b| Bucket {
            name: b.name().unwrap_or_default().to_string(),
            creation_date: fmt_dt(b.creation_date()),
        }));
        match resp.continuation_token() {
            Some(t) if !t.is_empty() && Some(t) != token.as_deref() => token = Some(t.to_string()),
            _ => break,
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

pub async fn list_objects(
    client: &Client,
    bucket: &str,
    prefix: &str,
    continuation_token: Option<String>,
    page_size: Option<i32>,
) -> AppResult<ListPage> {
    let page_size = page_size.filter(|n| *n > 0).unwrap_or(1000).min(1000);
    let resp = client
        .list_objects_v2()
        .bucket(bucket)
        .prefix(prefix)
        .delimiter("/")
        .max_keys(page_size)
        .set_continuation_token(continuation_token.clone().filter(|t| !t.is_empty()))
        .send()
        .await?;

    let folders = resp
        .common_prefixes()
        .iter()
        .filter_map(|cp| cp.prefix())
        .map(|p| FolderEntry { prefix: p.to_string(), name: last_segment(p) })
        .collect();

    let objects = resp
        .contents()
        .iter()
        .filter_map(|o| {
            let key = o.key()?;
            if key == prefix {
                return None; // folder marker
            }
            Some(object_entry(o, key))
        })
        .collect();

    // A browse page is requested one at a time, so only a token that repeats the one just sent
    // can be detected here (longer cycles would need the frontend's history).
    let sent = continuation_token.as_deref().filter(|t| !t.is_empty());
    let next = match next_list_page(resp.is_truncated(), resp.next_continuation_token(), |t| Some(t) == sent) {
        NextPage::Done => None,
        NextPage::Continue(t) => Some(t),
        NextPage::Error(why) => return Err(listing_error(bucket, prefix, why)),
    };
    Ok(ListPage { folders, objects, is_truncated: next.is_some(), next_continuation_token: next })
}

pub(crate) fn object_entry(o: &aws_sdk_s3::types::Object, key: &str) -> ObjectEntry {
    ObjectEntry {
        key: key.to_string(),
        name: last_segment(key),
        size: o.size().unwrap_or(0).max(0) as u64,
        last_modified: fmt_dt(o.last_modified()),
        etag: clean_etag(o.e_tag()),
        storage_class: o.storage_class().map(|s| s.as_str().to_string()),
    }
}

/// What to do after one `ListObjectsV2` page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NextPage {
    /// The listing is complete.
    Done,
    /// Request the next page with this token.
    Continue(String),
    /// The listing cannot be completed safely (stopping would silently drop keys).
    Error(&'static str),
}

/// Paging decision for `ListObjectsV2`. A non-empty `NextContinuationToken` is followed whatever
/// `IsTruncated` says (some servers omit `IsTruncated`); without one the listing ends, unless the
/// server said it is truncated. A token seen before (`seen`) is a server looping on the same
/// page: an error, except when the server also said the listing is complete.
pub(crate) fn next_list_page(
    is_truncated: Option<bool>,
    next_token: Option<&str>,
    seen: impl Fn(&str) -> bool,
) -> NextPage {
    match next_token.filter(|t| !t.is_empty()) {
        Some(t) if seen(t) => {
            if is_truncated == Some(false) {
                NextPage::Done
            } else {
                NextPage::Error("the server returned the same continuation token again")
            }
        }
        Some(t) => NextPage::Continue(t.to_string()),
        None if is_truncated == Some(true) => NextPage::Error("it was truncated without a usable continuation token"),
        None => NextPage::Done,
    }
}

pub(crate) fn listing_error(bucket: &str, prefix: &str, why: &str) -> AppError {
    AppError::new(ErrorCode::Unknown, format!("Listing {prefix:?} in {bucket} could not be completed: {why}"))
}

pub async fn head_object(client: &Client, bucket: &str, key: &str) -> AppResult<ObjectMeta> {
    if key.is_empty() {
        return Err(AppError::invalid("Object key is required"));
    }
    let h = client.head_object().bucket(bucket).key(key).send().await?;
    let archive = crate::archive::ArchiveInfo::from_head(&h);
    Ok(ObjectMeta {
        key: key.to_string(),
        name: last_segment(key),
        size: h.content_length().unwrap_or(0).max(0) as u64,
        last_modified: fmt_dt(h.last_modified()),
        etag: clean_etag(h.e_tag()),
        storage_class: Some(h.storage_class().map(|s| s.as_str().to_string()).unwrap_or_else(|| "STANDARD".into())),
        content_type: h.content_type().map(str::to_string),
        metadata: h.metadata().cloned().unwrap_or_default(),
        version_id: h.version_id().map(str::to_string),
        archived: archive.archived(chrono::Utc::now()),
        restore: archive.restore,
    })
}

/// Folder prefixes are used exactly as given (S3 keys may legitimately contain "//" or a
/// leading "/"); only a missing trailing '/' is appended. Nothing else is rewritten.
fn folder_prefix(prefix: &str) -> AppResult<String> {
    if prefix.is_empty() || prefix == "/" {
        return Err(AppError::invalid("Folder prefix is required"));
    }
    Ok(if prefix.ends_with('/') { prefix.to_string() } else { format!("{prefix}/") })
}

pub async fn create_folder(client: &Client, bucket: &str, prefix: &str) -> AppResult<()> {
    let prefix = folder_prefix(prefix)?;
    client
        .put_object()
        .bucket(bucket)
        .key(prefix)
        .content_length(0)
        .body(ByteStream::from_static(b""))
        .send()
        .await?;
    Ok(())
}

/// Lists every key under `prefix` (no delimiter). Paging follows [`next_list_page`] (the SDK
/// paginator would stop silently on a missing or repeated token).
pub async fn list_all_keys(client: &Client, bucket: &str, prefix: &str) -> AppResult<Vec<String>> {
    let mut keys = Vec::new();
    let mut token: Option<String> = None;
    let mut seen: HashSet<String> = HashSet::new();
    loop {
        let page =
            client.list_objects_v2().bucket(bucket).prefix(prefix).set_continuation_token(token.clone()).send().await?;
        keys.extend(page.contents().iter().filter_map(|o| o.key().map(str::to_string)));
        match next_list_page(page.is_truncated(), page.next_continuation_token(), |t| seen.contains(t)) {
            NextPage::Done => return Ok(keys),
            NextPage::Continue(t) => {
                seen.insert(t.clone());
                token = Some(t);
            }
            NextPage::Error(why) => return Err(listing_error(bucket, prefix, why)),
        }
    }
}

/// The most recently modified objects under `prefix`, at any depth, newest first. S3 only lists in
/// key order, so this scans the listing (no delimiter) and keeps the newest as it goes. It stops
/// after [`RECENT_SCAN_LIMIT`] objects and says so through `truncated`.
pub async fn list_recent(client: &Client, bucket: &str, prefix: &str) -> AppResult<RecentListing> {
    // (modification time in seconds, object); objects without a time sort last.
    let mut newest: Vec<(i64, ObjectEntry)> = Vec::new();
    let mut scanned: u64 = 0;
    let mut token: Option<String> = None;
    let mut seen: HashSet<String> = HashSet::new();
    loop {
        let page =
            client.list_objects_v2().bucket(bucket).prefix(prefix).set_continuation_token(token.clone()).send().await?;
        for o in page.contents() {
            // A key ending in '/' is a folder marker, not a file.
            let Some(key) = o.key().filter(|k| !k.ends_with('/')) else { continue };
            scanned += 1;
            newest.push((o.last_modified().map_or(i64::MIN, |t| t.secs()), object_entry(o, key)));
        }
        keep_newest(&mut newest, RECENT_MAX_RESULTS);
        let listing = |truncated| RecentListing {
            objects: newest.iter().map(|(_, o)| o.clone()).collect(),
            scanned,
            truncated,
        };
        match next_list_page(page.is_truncated(), page.next_continuation_token(), |t| seen.contains(t)) {
            NextPage::Done => return Ok(listing(false)),
            // More pages exist, so stopping here is a truncated result, never a complete one.
            NextPage::Continue(_) if scanned >= RECENT_SCAN_LIMIT => return Ok(listing(true)),
            NextPage::Continue(t) => {
                seen.insert(t.clone());
                token = Some(t);
            }
            NextPage::Error(why) => return Err(listing_error(bucket, prefix, why)),
        }
    }
}

/// Sorts newest first (ties by key, so the order is stable between scans) and keeps the first `max`.
fn keep_newest(items: &mut Vec<(i64, ObjectEntry)>, max: usize) {
    items.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.key.cmp(&b.1.key)));
    items.truncate(max);
}

#[cfg(test)]
mod tests {
    use super::{folder_prefix, keep_newest, next_list_page, NextPage};
    use crate::models::ObjectEntry;

    #[test]
    fn keep_newest_orders_by_time_then_key_and_caps() {
        let entry = |key: &str| ObjectEntry {
            key: key.to_string(),
            name: key.to_string(),
            size: 0,
            last_modified: None,
            etag: None,
            storage_class: None,
        };
        let mut items =
            vec![(10, entry("old")), (30, entry("b-new")), (i64::MIN, entry("undated")), (30, entry("a-new")), (20, entry("mid"))];
        keep_newest(&mut items, 4);
        let keys: Vec<&str> = items.iter().map(|(_, o)| o.key.as_str()).collect();
        // Newest first, equal times by key, and the undated object (which sorts last) is the one dropped.
        assert_eq!(keys, ["a-new", "b-new", "mid", "old"]);
        keep_newest(&mut items, 10);
        assert_eq!(items.len(), 4, "a larger cap never adds anything");
    }

    #[test]
    fn paging_follows_tokens_not_is_truncated() {
        let none = |_: &str| false;
        let c = |t: &str| NextPage::Continue(t.to_string());
        // Missing IsTruncated with a token: keep paging (used to stop and drop the rest).
        assert_eq!(next_list_page(None, Some("t1"), none), c("t1"));
        assert_eq!(next_list_page(Some(true), Some("t1"), none), c("t1"));
        assert_eq!(next_list_page(Some(false), Some("t1"), none), c("t1"), "a token is followed regardless");
        // No token: done, unless the server says there is more.
        assert_eq!(next_list_page(None, None, none), NextPage::Done);
        assert_eq!(next_list_page(Some(false), None, none), NextPage::Done);
        assert_eq!(next_list_page(Some(false), Some(""), none), NextPage::Done);
        assert!(matches!(next_list_page(Some(true), None, none), NextPage::Error(_)));
        assert!(matches!(next_list_page(Some(true), Some(""), none), NextPage::Error(_)));
        // A token seen before: the server is looping.
        let seen = |t: &str| t == "t1";
        assert!(matches!(next_list_page(Some(true), Some("t1"), seen), NextPage::Error(_)));
        assert!(matches!(next_list_page(None, Some("t1"), seen), NextPage::Error(_)));
        assert_eq!(next_list_page(Some(false), Some("t1"), seen), NextPage::Done, "explicitly complete");
        assert_eq!(next_list_page(None, Some("t2"), seen), c("t2"));
    }

    #[test]
    fn folder_prefix_is_never_normalized() {
        assert_eq!(folder_prefix("a/").unwrap(), "a/");
        assert_eq!(folder_prefix("a").unwrap(), "a/");
        assert_eq!(folder_prefix("a//").unwrap(), "a//");
        assert_eq!(folder_prefix("/foo/").unwrap(), "/foo/");
        assert_eq!(folder_prefix("a/b c/ü/").unwrap(), "a/b c/ü/");
        assert!(folder_prefix("").is_err());
        assert!(folder_prefix("/").is_err());
    }
}
