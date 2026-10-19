//! v0.9.0 "Command line: open the app at a location".
//!
//! ```text
//! s3explorer [--connection <saved connection name>] [<location>]
//! s3explorer --help
//! ```
//!
//! Parsed once at startup, before the Tauri builder runs (an invalid command line prints the usage
//! and exits 2; `--help` prints it and exits 0), and again for each second launch handed over by the
//! single-instance plugin (relative paths against that launch's own current directory).

use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Emitted with a [`LaunchRequest`] when a second launch hands its arguments over.
pub const LAUNCH_OPEN_EVENT: &str = "launch:open";

pub const USAGE: &str = "Usage:
  s3explorer [--connection <saved connection name>] [<location>]
  s3explorer --help

<location> is a local folder or file (absolute, or relative to the current folder)
or an S3 address: s3://bucket or s3://bucket/prefix/

Options:
  --connection <name>  connect with the saved connection of that name
  --help, -h           show this text";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct S3Location {
    pub bucket: String,
    /// Verbatim from the address ("" for the bucket root).
    pub prefix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    /// The `--connection` value, verbatim.
    pub connection: Option<String>,
    /// An absolute local path (file or folder), resolved against the launch's current folder.
    pub local: Option<String>,
    pub s3: Option<S3Location>,
    /// The arguments after the executable.
    pub raw: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Parsed {
    /// `--help`: print [`USAGE`] and exit 0.
    Help,
    /// `None`: no arguments, nothing to open.
    Request(Option<LaunchRequest>),
}

/// Parses the arguments after the executable. `Err` is the reason the command line is invalid
/// (print it with [`USAGE`] and exit 2).
pub fn parse(args: &[String], cwd: &Path) -> Result<Parsed, String> {
    // macOS used to pass `-psn_0_12345` to apps opened from the Finder.
    let args: Vec<String> = args.iter().filter(|a| !a.starts_with("-psn_")).cloned().collect();
    if args.is_empty() {
        return Ok(Parsed::Request(None));
    }
    let mut connection: Option<String> = None;
    let mut location: Option<String> = None;
    let mut only_locations = false;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if !only_locations && a.starts_with('-') && a != "-" {
            if a == "--" {
                only_locations = true;
                continue;
            }
            if a == "--help" || a == "-h" {
                return Ok(Parsed::Help);
            }
            let value = if a == "--connection" {
                it.next().cloned().ok_or("--connection needs the name of a saved connection")?
            } else if let Some(v) = a.strip_prefix("--connection=") {
                v.to_string()
            } else {
                return Err(format!("Unknown option {a}"));
            };
            if value.trim().is_empty() {
                return Err("--connection needs the name of a saved connection".into());
            }
            if connection.replace(value).is_some() {
                return Err("--connection was given twice".into());
            }
            continue;
        }
        if location.replace(a.clone()).is_some() {
            return Err("Only one location can be opened".into());
        }
    }
    let mut req = LaunchRequest { connection, local: None, s3: None, raw: args.clone() };
    if let Some(loc) = location {
        if let Some(s3) = parse_s3(&loc)? {
            req.s3 = Some(s3);
        } else {
            req.local = Some(resolve_local(&loc, cwd)?);
        }
    }
    Ok(Parsed::Request(Some(req)))
}

/// `s3://bucket[/prefix]` (scheme in any case); `Ok(None)` when it is not an S3 address at all.
fn parse_s3(loc: &str) -> Result<Option<S3Location>, String> {
    let Some(scheme) = loc.get(..5) else { return Ok(None) };
    if !scheme.eq_ignore_ascii_case("s3://") {
        return Ok(None);
    }
    let rest = &loc[5..];
    let (bucket, prefix) = rest.split_once('/').unwrap_or((rest, ""));
    if bucket.is_empty() {
        return Err(format!("{loc} has no bucket name (expected s3://bucket or s3://bucket/prefix/)"));
    }
    if bucket.chars().any(|c| c.is_whitespace() || c.is_control() || c == '\\') {
        return Err(format!("{loc}: {bucket:?} is not a bucket name"));
    }
    Ok(Some(S3Location { bucket: bucket.to_string(), prefix: prefix.to_string() }))
}

/// A local location made absolute against `cwd`, `.` and `..` resolved lexically, then held to the
/// local pane's path rules (no device path; v0.9.1: a UNC share `\\server\share[\...]` or
/// `//server/share` is accepted and written with backslashes, `\\server` alone is refused).
fn resolve_local(loc: &str, cwd: &Path) -> Result<String, String> {
    // Windows: `"C:\My Folder\"` arrives as `C:\My Folder"` (the backslash escapes the quote).
    let loc = if cfg!(windows) { loc.strip_suffix('"').unwrap_or(loc) } else { loc };
    if loc.trim().is_empty() {
        return Err("The location is empty".into());
    }
    // Starts like a UNC or device path: its `\\server\share` part is held to the rules as typed, so
    // `\\server` without a share is refused rather than read as the folder `\server` of the current
    // drive (`..` after the share is resolved below like anywhere else).
    if cfg!(windows) && loc.len() >= 2 && loc.chars().take(2).all(|c| c == '\\' || c == '/') {
        match Path::new(loc).components().next() {
            Some(Component::Prefix(p)) => {
                let mut share = p.as_os_str().to_os_string();
                share.push(r"\");
                crate::local_fs::check_path(&share.to_string_lossy()).map_err(|e| format!("{loc}: {}", e.message))?;
            }
            _ => return Err(format!(r"{loc}: not a valid network path (\\server\share)")),
        }
    }
    let joined = cwd.join(loc);
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            #[cfg(windows)]
            Component::Prefix(p) => match p.kind() {
                std::path::Prefix::UNC(server, share) => {
                    let mut unc = std::ffi::OsString::from(r"\\");
                    unc.push(server);
                    unc.push(r"\");
                    unc.push(share);
                    out.push(unc);
                }
                _ => out.push(c.as_os_str()),
            },
            Component::CurDir => {}
            Component::ParentDir => {
                // Never above the root.
                if out.file_name().is_some() {
                    out.pop();
                }
            }
            c => out.push(c.as_os_str()),
        }
    }
    let s = out.to_string_lossy().into_owned();
    crate::local_fs::check_path(&s).map_err(|e| e.message)?;
    Ok(s)
}

/// Prints to the console of the shell that launched the app. A Windows release build has no
/// console of its own, so it attaches to the parent's first (a no-op when there is none).
pub fn print(text: &str, to_stderr: bool) {
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn AttachConsole(process_id: u32) -> i32;
        }
        const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
        // SAFETY: no pointers; fails harmlessly when there is no parent console or one is attached.
        unsafe {
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
    use std::io::Write;
    // Write errors (no console at all) are ignored, never a panic.
    if to_stderr {
        let _ = writeln!(std::io::stderr(), "{text}");
    } else {
        let _ = writeln!(std::io::stdout(), "{text}");
    }
}

/// The startup request, handed to the frontend once by `take_launch_request`.
#[derive(Default)]
pub struct LaunchState(Mutex<Option<LaunchRequest>>);

impl LaunchState {
    pub fn new(req: Option<LaunchRequest>) -> Self {
        Self(Mutex::new(req))
    }

    pub fn take(&self) -> Option<LaunchRequest> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    fn cwd() -> PathBuf {
        PathBuf::from(if cfg!(windows) { r"C:\Users\Some One\Work Dir" } else { "/home/some one/work dir" })
    }

    fn req(a: &[&str]) -> LaunchRequest {
        match parse(&args(a), &cwd()).unwrap_or_else(|e| panic!("{a:?}: {e}")) {
            Parsed::Request(Some(r)) => r,
            other => panic!("{a:?}: {other:?}"),
        }
    }

    fn err(a: &[&str]) -> String {
        parse(&args(a), &cwd()).expect_err(&format!("{a:?} should be refused"))
    }

    fn s3(bucket: &str, prefix: &str) -> Option<S3Location> {
        Some(S3Location { bucket: bucket.into(), prefix: prefix.into() })
    }

    #[test]
    fn no_arguments_and_help() {
        assert_eq!(parse(&[], &cwd()), Ok(Parsed::Request(None)));
        assert_eq!(parse(&args(&["-psn_0_1234"]), &cwd()), Ok(Parsed::Request(None)));
        for h in [&["--help"][..], &["-h"], &["s3://b", "--help"], &["--connection", "x", "-h"]] {
            assert_eq!(parse(&args(h), &cwd()), Ok(Parsed::Help), "{h:?}");
        }
        assert!(USAGE.contains("--connection <name>") && USAGE.contains("s3://bucket"));
    }

    #[test]
    fn s3_addresses() {
        assert_eq!(req(&["s3://b"]).s3, s3("b", ""));
        assert_eq!(req(&["s3://b/"]).s3, s3("b", ""));
        assert_eq!(req(&["s3://b/a/b/"]).s3, s3("b", "a/b/"));
        assert_eq!(req(&["S3://My.Bucket/x"]).s3, s3("My.Bucket", "x"));
        // The prefix is verbatim: doubled slashes, spaces and dots are kept.
        assert_eq!(req(&["s3://b/a//b c/../"]).s3, s3("b", "a//b c/../"));
        let r = req(&["s3://b/p/"]);
        assert_eq!((r.local, r.connection, r.raw), (None, None, args(&["s3://b/p/"])));
        for bad in ["s3://", "s3:///p/", "s3://my bucket/", r"s3://a\b/"] {
            assert!(err(&[bad]).contains(bad), "{bad}");
        }
    }

    #[test]
    fn connection_option() {
        let r = req(&["--connection", "Prod account", "s3://b/x/"]);
        assert_eq!((r.connection.as_deref(), r.s3), (Some("Prod account"), s3("b", "x/")));
        assert_eq!(req(&["s3://b", "--connection=dev"]).connection.as_deref(), Some("dev"));
        // A connection alone is a request with no location.
        let r = req(&["--connection", "dev"]);
        assert_eq!((r.connection.as_deref(), r.local, r.s3), (Some("dev"), None, None));
        assert!(err(&["--connection"]).contains("--connection"));
        assert!(err(&["--connection", " "]).contains("--connection"));
        assert!(err(&["--connection", "a", "--connection", "b"]).contains("twice"));
    }

    #[test]
    fn errors() {
        assert!(err(&["--verbose"]).contains("Unknown option --verbose"));
        assert!(err(&["-x", "s3://b"]).contains("Unknown option"));
        assert!(err(&["s3://a", "s3://b"]).contains("Only one location"));
        assert!(err(&["dir", "other"]).contains("Only one location"));
        // After `--` a name starting with '-' is a location.
        let r = req(&["--", "-odd name"]);
        assert!(r.local.as_deref().is_some_and(|l| l.ends_with("-odd name")), "{:?}", r.local);
    }

    #[test]
    fn local_paths_resolve_against_the_current_folder() {
        let c = cwd();
        assert_eq!(req(&["sub dir"]).local, Some(c.join("sub dir").to_string_lossy().into_owned()));
        assert_eq!(req(&["."]).local, Some(c.to_string_lossy().into_owned()));
        assert_eq!(req(&["../x y/./z.txt"]).local, Some(c.parent().expect("parent").join("x y").join("z.txt").to_string_lossy().into_owned()));
        if cfg!(windows) {
            assert_eq!(req(&[r"D:\My Files\report 1.pdf"]).local.as_deref(), Some(r"D:\My Files\report 1.pdf"));
            assert_eq!(req(&["D:/My Files/a"]).local.as_deref(), Some(r"D:\My Files\a"));
            // `"D:\My Folder\"` as cmd.exe passes it.
            assert_eq!(req(&["D:\\My Folder\""]).local.as_deref(), Some(r"D:\My Folder"));
            assert_eq!(req(&[r"C:\..\..\x"]).local.as_deref(), Some(r"C:\x"));
            // Root-relative: the current folder's drive.
            assert_eq!(req(&[r"\Temp"]).local.as_deref(), Some(r"C:\Temp"));
            // v0.9.1: network shares, written with backslashes; `..` never climbs above the share.
            assert_eq!(req(&[r"\\server\share\x y"]).local.as_deref(), Some(r"\\server\share\x y"));
            assert_eq!(req(&["//server/share/a/b"]).local.as_deref(), Some(r"\\server\share\a\b"));
            assert_eq!(req(&["//server/share"]).local.as_deref(), Some(r"\\server\share\"));
            assert_eq!(req(&[r"\\server\share\a\..\..\..\b"]).local.as_deref(), Some(r"\\server\share\b"));
            for bad in [
                r"\\?\C:\x",
                r"\\?\UNC\server\share",
                r"\\.\PhysicalDrive0",
                "//./C:/x",
                r"\\server",
                r"\\server\",
                "//server",
                r"\\server\..\x",
                "D:relative",
            ] {
                assert!(parse(&args(&[bad]), &c).is_err(), "{bad}");
            }
        } else {
            assert_eq!(req(&["/tmp/a b"]).local.as_deref(), Some("/tmp/a b"));
            assert_eq!(req(&["/../x"]).local.as_deref(), Some("/x"));
        }
        // The raw arguments are kept for messages.
        assert_eq!(req(&["--connection", "c", "x"]).raw, args(&["--connection", "c", "x"]));
    }

    #[test]
    fn the_request_is_taken_once_and_serializes_camel_case() {
        let r = req(&["--connection", "c", "s3://b/p/"]);
        let v = serde_json::to_value(&r).expect("ser");
        assert_eq!(v, serde_json::json!({"connection": "c", "local": null, "s3": {"bucket": "b", "prefix": "p/"}, "raw": ["--connection", "c", "s3://b/p/"]}));
        let st = LaunchState::new(Some(r.clone()));
        assert_eq!(st.take(), Some(r));
        assert_eq!(st.take(), None);
        assert_eq!(LAUNCH_OPEN_EVENT, "launch:open");
    }
}
