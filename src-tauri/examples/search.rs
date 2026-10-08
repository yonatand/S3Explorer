//! End-to-end tests for v0.6.0's `search_objects` against a local S3-compatible server
//! (SeaweedFS, see the smoke-test skill).
//!
//! Seeds a bucket with a few hundred keys across folders (some tagged, plus folder markers) and
//! checks keywords (AND), phrases, exclusions, tag terms, path narrowing, the exact-path hit,
//! the narrowing fallback, the hit limit, folder markers, and cancellation (re-used search id,
//! cancel_search, disconnect).
//!
//! Env: SMOKE_ENDPOINT (default http://127.0.0.1:8333), SMOKE_ACCESS_KEY / SMOKE_SECRET_KEY
//! (default minioadmin/minioadmin).
//!
//! Run: `cargo run --example search`

use std::sync::Arc;
use std::time::{Duration, Instant};

use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client;
use futures::stream::{self, StreamExt};
use s3explorer_lib::error::{AppError, ErrorCode};
use s3explorer_lib::models::{ConnectionConfig, ObjectEntry, SearchHit, SearchHitKind, SearchQuery, SearchResult, Tag};
use s3explorer_lib::search::{self, SearchRegistry};
use s3explorer_lib::state::Connection;
use s3explorer_lib::{ops, tags};

type Res<T> = Result<T, Box<dyn std::error::Error>>;

const B: &str = "search-e2e";

fn env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

fn check(cond: bool, what: &str) -> Res<()> {
    if cond {
        println!("  ok  {what}");
        Ok(())
    } else {
        Err(format!("FAILED: {what}").into())
    }
}

fn expect_err<T: std::fmt::Debug>(r: Result<T, AppError>, code: ErrorCode, what: &str) -> Res<AppError> {
    match r {
        Ok(v) => Err(format!("FAILED: {what}: expected {code:?}, got Ok({v:?})").into()),
        Err(e) if e.code == code => {
            println!("  ok  {what} -> {:?}: {}", e.code, e.message);
            Ok(e)
        }
        Err(e) => Err(format!("FAILED: {what}: expected {code:?}, got {:?}: {}", e.code, e.message).into()),
    }
}

fn q(scope: &str, text: &str, limit: i64) -> SearchQuery {
    SearchQuery { bucket: B.into(), scope: scope.into(), text: text.into(), limit }
}

/// Every hit as its key (objects) or prefix (folders), in result order.
fn keys(r: &SearchResult) -> Vec<&str> {
    r.hits.iter().map(id).collect()
}

fn id(h: &SearchHit) -> &str {
    match (&h.entry, &h.folder) {
        (Some(o), _) => o.key.as_str(),
        (None, Some(f)) => f.prefix.as_str(),
        (None, None) => "",
    }
}

/// The object of an object hit; panics on a folder hit (the checks using it expect objects only).
fn e(h: &SearchHit) -> &ObjectEntry {
    h.entry.as_ref().unwrap_or_else(|| panic!("expected an object hit, got the folder {}", id(h)))
}

/// Only the folder hits, as prefixes.
fn folders(r: &SearchResult) -> Vec<&str> {
    r.hits.iter().filter(|h| h.kind == SearchHitKind::Folder).map(id).collect()
}

/// The seeded files (no folder markers) and their tags.
fn seed_plan() -> Vec<(String, Vec<Tag>)> {
    let mut v = Vec::new();
    for i in 1..=100 {
        let tg = if i <= 5 { vec![Tag::new("owner", "alice")] } else { vec![] };
        v.push((format!("billing/2026/invoice-{i:04}.pdf"), tg));
    }
    for i in 1..=50 {
        let tg = if i <= 3 { vec![Tag::new("project", "Big Data")] } else { vec![] };
        v.push((format!("billing/2025/invoice-{i:04}.pdf"), tg));
    }
    for i in 1..=150 {
        let tg = match i {
            1..=20 => vec![Tag::new("env", "Prod"), Tag::new("team", "web")],
            21..=30 => vec![Tag::new("env", "dev")],
            _ => vec![],
        };
        v.push((format!("photos/2024/IMG_{i:04}.jpg"), tg));
    }
    for k in ["docs/Q1 final report.txt", "docs/Q1 final draft.txt", "docs/q1-final.txt", "docs/Größe.txt", "docs/notes.md"] {
        v.push((k.to_string(), vec![]));
    }
    v
}

const MARKERS: [&str; 3] = ["photos/", "docs/empty/", "billing/2026/"];

async fn wipe(c: &Client) -> Res<()> {
    let all = ops::list_all_keys(c, B, "").await?;
    let results: Vec<_> = stream::iter(all)
        .map(|k| async move { c.delete_object().bucket(B).key(k).send().await })
        .buffer_unordered(32)
        .collect()
        .await;
    for r in results {
        r?;
    }
    Ok(())
}

async fn seed(c: &Client) -> Res<usize> {
    let plan = seed_plan();
    let n = plan.len();
    let results: Vec<Res<()>> = stream::iter(plan)
        .map(|(k, tg)| async move {
            c.put_object().bucket(B).key(&k).body(ByteStream::from(k.clone().into_bytes())).send().await?;
            if !tg.is_empty() {
                tags::put_object_tags(c, B, &k, &tg, &[]).await?;
            }
            Ok(())
        })
        .buffer_unordered(32)
        .collect()
        .await;
    for r in results {
        r?;
    }
    for m in MARKERS {
        c.put_object().bucket(B).key(m).body(ByteStream::from_static(b"")).send().await?;
    }
    Ok(n)
}

#[tokio::main]
async fn main() -> Res<()> {
    let endpoint = env("SMOKE_ENDPOINT", "http://127.0.0.1:8333");
    let ak = env("SMOKE_ACCESS_KEY", "minioadmin");
    let sk = env("SMOKE_SECRET_KEY", "minioadmin");
    let conn = Connection::open(ConnectionConfig::Static {
        access_key_id: ak,
        secret_access_key: sk,
        session_token: None,
        region: "us-east-1".into(),
        endpoint: Some(endpoint),
        force_path_style: None,
    })
    .await?;
    let c = conn.client_for_bucket(B).await;
    let _ = c.create_bucket().bucket(B).send().await;
    wipe(&c).await?;
    let t0 = Instant::now();
    let files = seed(&c).await? as u64;
    println!("seeded {files} files + {} folder markers in {:?}", MARKERS.len(), t0.elapsed());
    let all = ops::list_all_keys(&c, B, "").await?;
    check(all.len() as u64 == files + MARKERS.len() as u64, &format!("bucket holds {} keys", all.len()))?;

    println!("keywords (AND), whole bucket");
    let r = search::search(&c, &q("", "invoice 2026", 500)).await?;
    check(r.hits.len() == 100, &format!("invoice 2026 -> {} hits", r.hits.len()))?;
    check(r.hits.iter().all(|h| e(h).key.starts_with("billing/2026/invoice-") && !h.exact && h.tags.is_none()), "every hit is a 2026 invoice")?;
    check(r.scanned == files, &format!("scanned {} = files (markers not counted)", r.scanned))?;
    check(!r.truncated && r.reason.is_none() && r.tag_lookups == 0, "complete, no tag lookups")?;
    check(r.parsed.list_prefix.is_empty() && r.parsed.words == ["invoice", "2026"], "parsed words, no narrowing")?;
    let ks = keys(&r);
    check(ks.windows(2).all(|w| w[0] < w[1]), "hits in key order")?;

    println!("case-insensitive, non-ASCII");
    let r = search::search(&c, &q("", "GRÖßE", 500)).await?;
    check(keys(&r) == ["docs/Größe.txt"], &format!("GRÖßE -> {:?}", keys(&r)))?;
    let r = search::search(&c, &q("", "img_0150", 500)).await?;
    check(keys(&r) == ["photos/2024/IMG_0150.jpg"], "img_0150 finds IMG_0150")?;

    println!("phrases and exclusions");
    let r = search::search(&c, &q("", r#""q1 final""#, 500)).await?;
    check(keys(&r) == ["docs/Q1 final draft.txt", "docs/Q1 final report.txt"], &format!("\"q1 final\" -> {:?}", keys(&r)))?;
    let r = search::search(&c, &q("", r#""q1 final" -draft"#, 500)).await?;
    check(keys(&r) == ["docs/Q1 final report.txt"], "\"q1 final\" -draft")?;
    let r = search::search(&c, &q("", r#"q1 -"final draft""#, 500)).await?;
    check(keys(&r) == ["docs/Q1 final report.txt", "docs/q1-final.txt"], &format!("q1 -\"final draft\" -> {:?}", keys(&r)))?;
    let r = search::search(&c, &q("", "invoice -2026", 500)).await?;
    check(r.hits.len() == 50 && r.hits.iter().all(|h| e(h).key.starts_with("billing/2025/")), "invoice -2026 -> the 50 from 2025")?;

    println!("tag terms");
    let r = search::search(&c, &q("", "photos tag:env=prod", 500)).await?;
    check(r.hits.len() == 20, &format!("photos tag:env=prod -> {} hits (value case-insensitive)", r.hits.len()))?;
    check(r.tag_lookups == 150, &format!("one lookup per candidate: {}", r.tag_lookups))?;
    check(
        r.hits.iter().all(|h| h.tags.as_ref().is_some_and(|t| t.contains(&Tag::new("env", "Prod")) && t.len() == 2)),
        "hits carry their tag sets",
    )?;
    let r = search::search(&c, &q("", "tag:env", 500)).await?;
    check(r.hits.len() == 30 && r.tag_lookups == files, &format!("tag:env -> {} hits, {} lookups", r.hits.len(), r.tag_lookups))?;
    let r = search::search(&c, &q("", "tag:Env", 500)).await?;
    check(r.hits.is_empty(), "tag:Env -> none (tag keys are case-sensitive)")?;
    let r = search::search(&c, &q("billing/", "tag:owner=ALICE 2026", 500)).await?;
    check(r.hits.len() == 5 && r.tag_lookups == 100, &format!("billing/ tag:owner=ALICE 2026 -> {} hits, {} lookups", r.hits.len(), r.tag_lookups))?;
    let r = search::search(&c, &q("", "tag:env=dev -IMG_0025", 500)).await?;
    check(r.hits.len() == 9, "tag:env=dev minus one excluded key -> 9")?;

    let r = search::search(&c, &q("billing/", r#"tag:project="big DATA""#, 500)).await?;
    check(
        keys(&r) == ["billing/2025/invoice-0001.pdf", "billing/2025/invoice-0002.pdf", "billing/2025/invoice-0003.pdf"],
        &format!("tag:project=\"big DATA\" (quoted value with a space) -> {:?}", keys(&r)),
    )?;
    check(r.parsed.tags.len() == 1 && r.parsed.tags[0].value.as_deref() == Some("big DATA"), "parsed as one tag term")?;
    let r = search::search(&c, &q("billing/", "TAG:project", 500)).await?;
    check(r.hits.len() == 3, "TAG: prefix is case-insensitive")?;
    println!("path narrowing");
    let r = search::search(&c, &q("", "photos/2024/IMG_00", 500)).await?;
    check(r.parsed.list_prefix == "photos/2024/", &format!("listPrefix {:?}", r.parsed.list_prefix))?;
    check(r.scanned == 150, &format!("scanned only the folder: {}", r.scanned))?;
    check(r.hits.len() == 99 && r.hits.iter().all(|h| !h.exact), "IMG_0001..IMG_0099, no exact hit")?;
    check(r.parsed.exact_path.as_deref() == Some("photos/2024/IMG_00"), "exactPath reported as typed")?;
    let r = search::search(&c, &q("photos/", "2024/IMG_001 jpg", 500)).await?;
    check(r.parsed.list_prefix == "photos/", "a term beside the scope keeps the scope")?;
    check(r.hits.len() == 10, &format!("2024/IMG_001 jpg under photos/ -> {}", r.hits.len()))?;
    let r = search::search(&c, &q("billing/2026/", "billing/x", 500)).await?;
    check(r.parsed.list_prefix == "billing/2026/" && r.hits.is_empty(), "a term above the scope keeps the scope")?;
    let r = search::search(&c, &q("billing/", "billing/2025/ invoice", 500)).await?;
    check(r.parsed.list_prefix == "billing/2025/" && r.scanned == 50 && r.hits.len() == 50, "narrowed to billing/2025/")?;

    println!("exact path");
    let r = search::search(&c, &q("", "billing/2025/invoice-0007.pdf", 500)).await?;
    check(r.hits.len() == 1 && r.hits[0].exact && e(&r.hits[0]).key == "billing/2025/invoice-0007.pdf", "exact hit, once")?;
    check(e(&r.hits[0]).size == "billing/2025/invoice-0007.pdf".len() as u64, "exact hit has the object's size")?;
    let r = search::search(&c, &q("photos/", "billing/2025/invoice-0007.pdf", 500)).await?;
    check(r.parsed.list_prefix == "photos/" && keys(&r) == ["billing/2025/invoice-0007.pdf"] && r.hits[0].exact, "exact hit outside the scope")?;
    let r = search::search(&c, &q("", "billing/2026/invoice-00", 500)).await?;
    check(r.hits.len() == 99 && !r.hits.iter().any(|h| h.exact), "a missing exact path is not an error")?;
    let r = search::search(&c, &q("", "BILLING/2025/invoice-0007.pdf", 500)).await?;
    check(
        keys(&r) == ["billing/2025/invoice-0007.pdf"] && !r.hits[0].exact && r.parsed.list_prefix.is_empty() && r.scanned == files,
        "the typed case is headed as is (no exact hit); the empty narrowed listing falls back to the scope",
    )?;

    println!("narrowing fallback");
    let r = search::search(&c, &q("", "Photos/2024/IMG_0001.jpg", 500)).await?;
    check(
        r.parsed.exact_path.as_deref() == Some("Photos/2024/IMG_0001.jpg") && keys(&r) == ["photos/2024/IMG_0001.jpg"] && !r.hits[0].exact,
        "Photos/2024/IMG_0001.jpg: the exact head 404s, the scan still finds photos/2024/IMG_0001.jpg",
    )?;
    check(r.parsed.list_prefix.is_empty() && r.scanned == files, "after falling back to the scope")?;
    let r = search::search(&c, &q("", "Photos/2024/IMG_001", 500)).await?;
    check(r.hits.len() == 10 && r.hits.iter().all(|h| e(h).key.starts_with("photos/2024/IMG_001")), &format!("Photos/2024/IMG_001 finds photos/ keys: {}", r.hits.len()))?;
    check(r.parsed.list_prefix.is_empty() && r.scanned == files, &format!("listPrefix == scope, scanned {} (second scan only)", r.scanned))?;
    let r = search::search(&c, &q("photos/", "photos/2024/Raw/ jpg", 500)).await?;
    check(r.parsed.list_prefix == "photos/" && r.scanned == 150 && r.hits.is_empty(), "an empty photos/2024/Raw/ falls back to the scope photos/")?;
    let r = search::search(&c, &q("", "billing/2025/ zzz", 500)).await?;
    check(r.parsed.list_prefix == "billing/2025/" && r.scanned == 50 && r.hits.is_empty(), "keys but no hits: not retried")?;
    let r = search::search(&c, &q("", "billing/2025/invoice-0007.pdf", 1)).await?;
    check(r.hits.len() == 1 && r.hits[0].exact && r.truncated && r.scanned == 0, "limit 1 is filled by the exact hit")?;

    println!("limit");
    let r = search::search(&c, &q("", "invoice", 10)).await?;
    check(r.hits.len() == 10 && r.truncated, "invoice limit 10 -> 10, truncated")?;
    check(r.reason.as_deref() == Some("Stopped at 10 results"), &format!("reason {:?}", r.reason))?;
    check(keys(&r)[0] == "billing/2025/invoice-0001.pdf" && keys(&r).windows(2).all(|w| w[0] < w[1]), "first 10 in key order")?;
    let r = search::search(&c, &q("", "photos tag:env", 5)).await?;
    check(r.hits.len() == 5 && r.truncated && r.reason.as_deref() == Some("Stopped at 5 results"), "tag search stops at the limit")?;
    check(r.tag_lookups < 150, &format!("and stops looking up tags ({})", r.tag_lookups))?;
    let r = search::search(&c, &q("docs/", "docs", 6)).await?;
    check(r.hits.len() == 6 && folders(&r) == ["docs/empty/"] && !r.truncated, "exactly the limit (a folder and 5 files) at the end is complete")?;

    println!("folders");
    let r = search::search(&c, &q("", "photos", 1000)).await?;
    check(folders(&r) == ["photos/", "photos/2024/"] && r.hits.len() == 152, &format!("photos -> folders {:?} first, then 150 objects", folders(&r)))?;
    check(r.hits[..2].iter().all(|h| h.kind == SearchHitKind::Folder) && r.hits[2..].iter().all(|h| h.kind == SearchHitKind::Object), "folders before objects")?;
    check(r.scanned == files, "folder markers are not scanned objects")?;
    let r = search::search(&c, &q("", "empty", 1000)).await?;
    check(keys(&r) == ["docs/empty/"] && r.hits[0].kind == SearchHitKind::Folder, "a keyword matching only a folder name (docs/empty/, a marker)")?;
    let r = search::search(&c, &q("", "photos/", 1000)).await?;
    check(r.hits[0].exact && keys(&r)[0] == "photos/" && r.hits[0].kind == SearchHitKind::Folder, "photos/ alone is the exact folder")?;
    check(keys(&r)[1] == "photos/2024/" && r.hits.len() == 152 && !r.hits[1..].iter().any(|h| h.exact), "then the folder below, then the objects")?;
    let r = search::search(&c, &q("", "billing/2025", 1000)).await?;
    check(keys(&r)[0] == "billing/2025/" && r.hits[0].exact && r.hits[0].kind == SearchHitKind::Folder, "billing/2025 finds the folder first")?;
    check(r.hits.len() == 51 && r.parsed.list_prefix == "billing/", &format!("then its 50 invoices ({} hits)", r.hits.len()))?;
    let r = search::search(&c, &q("", "2024", 3)).await?;
    check(keys(&r) == ["photos/2024/", "photos/2024/IMG_0001.jpg", "photos/2024/IMG_0002.jpg"] && r.truncated, "folders count toward the limit")?;
    let r = search::search(&c, &q("", "photos tag:env", 1000)).await?;
    check(folders(&r).is_empty() && r.hits.len() == 30, "no folder hits with tag terms")?;
    let r = search::search(&c, &q("", r#"path:"docs/Q1 final report.txt""#, 1000)).await?;
    check(
        r.hits[0].exact && keys(&r) == ["docs/Q1 final report.txt"] && r.parsed.list_prefix == "docs/",
        "path:\"docs/Q1 final report.txt\" is an exact object with a space",
    )?;

    println!("validation");
    expect_err(search::search(&c, &q("", "  ", 10)).await, ErrorCode::InvalidInput, "empty query")?;
    expect_err(search::search(&c, &q("", "\"\"", 10)).await, ErrorCode::InvalidInput, "only an empty phrase")?;
    expect_err(search::search(&c, &q("", "x", 0)).await, ErrorCode::InvalidInput, "limit 0")?;
    expect_err(search::search(&c, &q("", "x", 1001)).await, ErrorCode::InvalidInput, "limit 1001")?;

    println!("cancellation");
    let reg = Arc::new(SearchRegistry::new());
    let c2 = c.clone();
    let reg2 = reg.clone();
    let older = tokio::spawn(async move {
        let q = q("", "tag:env", 1000);
        reg2.run("box", search::search(&c2, &q)).await
    });
    while reg.running() == 0 {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    tokio::time::sleep(Duration::from_millis(10)).await;
    let newer = reg.run("box", search::search(&c, &q("", "invoice 2026", 500))).await?;
    check(newer.hits.len() == 100, "the newer search with the same id completes")?;
    expect_err(older.await?, ErrorCode::Cancelled, "the older search with the same id")?;
    let c3 = c.clone();
    let reg3 = reg.clone();
    let running = tokio::spawn(async move {
        let q = q("", "tag:env", 1000);
        reg3.run("other", search::search(&c3, &q)).await
    });
    while reg.running() == 0 {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    reg.cancel_all();
    expect_err(running.await?, ErrorCode::Cancelled, "cancel_all (disconnect)")?;
    check(reg.running() == 0, "nothing left running")?;
    // cancel_search: cancels that id only; a no-op when nothing runs under it.
    reg.cancel("not-running");
    let c4 = c.clone();
    let reg4 = reg.clone();
    let target = tokio::spawn(async move {
        let q = q("", "tag:env", 1000);
        reg4.run("cancel-me", search::search(&c4, &q)).await
    });
    while reg.running() == 0 {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    reg.cancel("cancel-me");
    expect_err(target.await?, ErrorCode::Cancelled, "cancel_search on a running search")?;
    check(reg.running() == 0, "cancel_search forgot the id")?;
    let r = reg.run("cancel-me", search::search(&c, &q("", "invoice 2026", 500))).await?;
    check(r.hits.len() == 100, "the id can be reused after cancel_search")?;

    // What survived: searching is read-only.
    let after = ops::list_all_keys(&c, B, "").await?;
    check(after == all, "the bucket is unchanged")?;
    println!("ALL SEARCH CHECKS PASSED in {:?}", t0.elapsed());
    Ok(())
}
