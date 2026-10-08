//! Persisted app settings (`settings.json` in the app config dir).
//!
//! Free of Tauri types: the path is resolved by the caller (the Tauri `setup` hook), so the store
//! is unit-testable against a temp dir.
//!
//! Loading never fails: a missing, unreadable or unparsable (not JSON) file yields the defaults
//! wholesale; in a file that parses, each field that is missing, of the wrong type, unknown or out
//! of range falls back to its own default and the valid fields are kept (see
//! [`AppSettings::from_json_lenient`]). A v0.2.0 file (three fields) loads with the new fields at
//! their defaults.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::error::{AppError, AppResult, ErrorCode};
use crate::models::AppSettings;

pub const SETTINGS_FILE: &str = "settings.json";

/// Reads settings from `path`, falling back to defaults (see module docs). Never fails.
pub fn load(path: &Path) -> AppSettings {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .map(|v| AppSettings::from_json_lenient(&v))
        .unwrap_or_default()
}

/// Writes `settings` to `path` atomically (see [`write_json_atomic`]).
pub fn save(path: &Path, settings: &AppSettings) -> AppResult<()> {
    write_json_atomic(path, settings, "settings")
}

/// Writes `value` as pretty JSON to `path` atomically: a unique temp file in the same directory is
/// written and flushed to disk, then renamed over the target. Creates the directory if missing.
/// `what` names the data in error messages ("Could not save {what}: ...").
pub fn write_json_atomic<T: serde::Serialize + ?Sized>(path: &Path, value: &T, what: &str) -> AppResult<()> {
    let io = |action: &str, e: std::io::Error| AppError::new(ErrorCode::Io, format!("Could not {action} {what}: {e}"));
    let dir = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir).map_err(|e| io("create the folder for", e))?;
    let json = serde_json::to_vec_pretty(value)
        .map_err(|e| AppError::new(ErrorCode::Unknown, format!("Could not serialize {what}: {e}")))?;
    let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "data.json".into());
    let tmp = dir.join(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4().simple()));
    let write = || -> std::io::Result<()> {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(&json)?;
        f.sync_all()?;
        drop(f);
        // `rename` replaces an existing target on both Windows and Unix.
        std::fs::rename(&tmp, path)
    };
    write().map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        io("save", e)
    })
}

/// Current settings plus where they persist. `path: None` keeps them in memory only.
pub struct SettingsStore {
    path: Option<PathBuf>,
    current: Mutex<AppSettings>,
    /// Serializes updates so the file, the in-memory value and whatever `apply` feeds always agree.
    update_lock: tokio::sync::Mutex<()>,
}

impl SettingsStore {
    /// Loads from `path` (defaults if absent/invalid) and persists future updates there.
    pub fn load(path: PathBuf) -> Self {
        let current = load(&path);
        Self { path: Some(path), current: Mutex::new(current), update_lock: tokio::sync::Mutex::new(()) }
    }

    /// In-memory store (no persistence), e.g. when the config dir cannot be resolved.
    pub fn in_memory(settings: AppSettings) -> Self {
        Self { path: None, current: Mutex::new(settings), update_lock: tokio::sync::Mutex::new(()) }
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn get(&self) -> AppSettings {
        self.current.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Validates, persists, then swaps the in-memory value and calls `apply` with it (all under one
    /// lock, so concurrent updates are applied in the same order they are stored). On a validation
    /// or disk error nothing changes.
    pub async fn update(
        &self,
        settings: AppSettings,
        apply: impl FnOnce(&AppSettings),
    ) -> AppResult<AppSettings> {
        settings.validate()?;
        let _guard = self.update_lock.lock().await;
        if let Some(path) = self.path.clone() {
            let to_save = settings.clone();
            tokio::task::spawn_blocking(move || save(&path, &to_save)).await??;
        }
        *self.current.lock().unwrap_or_else(|p| p.into_inner()) = settings.clone();
        apply(&settings);
        Ok(settings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::*;
    use serde_json::json;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("s3explorer-settings-{name}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&d).expect("mkdir");
        d
    }

    fn s(part: Option<u32>, parts: u32, transfers: u32) -> AppSettings {
        AppSettings {
            part_size_mib: part,
            max_concurrent_parts: parts,
            max_concurrent_transfers: transfers,
            ..AppSettings::default()
        }
    }

    fn err_msg(r: AppResult<()>) -> String {
        let e = r.expect_err("should be rejected");
        assert_eq!(e.code, ErrorCode::InvalidInput);
        e.message
    }

    #[test]
    fn defaults_match_contract() {
        let d = AppSettings::default();
        assert_eq!(d, s(None, 8, 4));
        assert_eq!(
            serde_json::to_value(&d).expect("ser"),
            json!({
                "partSizeMib": null,
                "maxConcurrentParts": 8,
                "maxConcurrentTransfers": 4,
                "theme": "system",
                "checkUpdatesOnStartup": false,
                "notifyOnFinish": true,
                "textSize": 100,
                "textWeight": 400,
                "accent": "yellow",
                "confirmCopyMove": true,
                "fileManagerCommand": null
            })
        );
        assert!(d.validate().is_ok());
    }

    #[test]
    fn validation_bounds() {
        // partSizeMib: null (Auto), min, max ok; min-1, max+1 rejected.
        for ok in [None, Some(PART_SIZE_MIB_MIN), Some(PART_SIZE_MIB_MAX)] {
            assert!(s(ok, 8, 4).validate().is_ok(), "{ok:?}");
        }
        for bad in [PART_SIZE_MIB_MIN - 1, PART_SIZE_MIB_MAX + 1] {
            let m = err_msg(s(Some(bad), 8, 4).validate());
            assert!(m.contains("partSizeMib") && m.contains("1 to 256"), "{m}");
        }
        for ok in [MAX_CONCURRENT_PARTS_MIN, MAX_CONCURRENT_PARTS_MAX] {
            assert!(s(None, ok, 4).validate().is_ok());
        }
        for bad in [MAX_CONCURRENT_PARTS_MIN - 1, MAX_CONCURRENT_PARTS_MAX + 1] {
            let m = err_msg(s(None, bad, 4).validate());
            assert!(m.contains("maxConcurrentParts") && m.contains("1 to 32"), "{m}");
        }
        for ok in [MAX_CONCURRENT_TRANSFERS_MIN, MAX_CONCURRENT_TRANSFERS_MAX] {
            assert!(s(None, 8, ok).validate().is_ok());
        }
        for bad in [MAX_CONCURRENT_TRANSFERS_MIN - 1, MAX_CONCURRENT_TRANSFERS_MAX + 1] {
            let m = err_msg(s(None, 8, bad).validate());
            assert!(m.contains("maxConcurrentTransfers") && m.contains("1 to 10"), "{m}");
        }
    }

    /// Adds the fields introduced after v0.2.0 (at their defaults) when the case does not set them.
    fn full(mut v: serde_json::Value) -> serde_json::Value {
        let o = v.as_object_mut().expect("object");
        o.entry("theme").or_insert(json!("system"));
        o.entry("checkUpdatesOnStartup").or_insert(json!(false));
        o.entry("notifyOnFinish").or_insert(json!(true));
        o.entry("textSize").or_insert(json!(100));
        o.entry("textWeight").or_insert(json!(400));
        o.entry("accent").or_insert(json!("yellow"));
        o.entry("confirmCopyMove").or_insert(json!(true));
        o.entry("fileManagerCommand").or_insert(serde_json::Value::Null);
        v
    }

    #[test]
    fn strict_parse_for_update_command() {
        let ok = AppSettings::from_json_strict(&full(
            json!({"partSizeMib": 16, "maxConcurrentParts": 3, "maxConcurrentTransfers": 2, "extra": true}),
        ))
        .expect("valid");
        assert_eq!(ok, s(Some(16), 3, 2));
        let auto = AppSettings::from_json_strict(&full(
            json!({"partSizeMib": null, "maxConcurrentParts": 1, "maxConcurrentTransfers": 10}),
        ))
        .expect("valid");
        assert_eq!(auto, s(None, 1, 10));

        let cases = [
            (json!({"partSizeMib": 2.5, "maxConcurrentParts": 8, "maxConcurrentTransfers": 4}), "partSizeMib"),
            (json!({"partSizeMib": "8", "maxConcurrentParts": 8, "maxConcurrentTransfers": 4}), "partSizeMib"),
            (json!({"partSizeMib": 0, "maxConcurrentParts": 8, "maxConcurrentTransfers": 4}), "partSizeMib"),
            (json!({"maxConcurrentParts": 8, "maxConcurrentTransfers": 4}), "partSizeMib"),
            (json!({"partSizeMib": null, "maxConcurrentParts": -1, "maxConcurrentTransfers": 4}), "maxConcurrentParts"),
            (json!({"partSizeMib": null, "maxConcurrentParts": 8.5, "maxConcurrentTransfers": 4}), "maxConcurrentParts"),
            (json!({"partSizeMib": null, "maxConcurrentParts": 33, "maxConcurrentTransfers": 4}), "maxConcurrentParts"),
            (json!({"partSizeMib": null, "maxConcurrentParts": 8, "maxConcurrentTransfers": 11}), "maxConcurrentTransfers"),
            (json!({"partSizeMib": null, "maxConcurrentParts": 8, "maxConcurrentTransfers": 4294967297u64}), "maxConcurrentTransfers"),
            (json!({"partSizeMib": null, "maxConcurrentParts": 8}), "maxConcurrentTransfers"),
        ];
        for (v, field) in cases {
            let v = full(v);
            let e = AppSettings::from_json_strict(&v).expect_err(&v.to_string());
            assert_eq!(e.code, ErrorCode::InvalidInput);
            assert!(e.message.starts_with(field), "{v} -> {}", e.message);
        }
        assert!(AppSettings::from_json_strict(&json!([1, 2])).is_err());
    }

    #[test]
    fn strict_parse_theme_and_update_flag() {
        let base =
            json!({"partSizeMib": null, "maxConcurrentParts": 8, "maxConcurrentTransfers": 4, "notifyOnFinish": true, "textSize": 100, "textWeight": 400, "accent": "yellow", "confirmCopyMove": true, "fileManagerCommand": null});
        let with = |theme: Option<serde_json::Value>, flag: Option<serde_json::Value>| {
            let mut v = base.clone();
            let o = v.as_object_mut().expect("object");
            if let Some(theme) = theme {
                o.insert("theme".into(), theme);
            }
            if let Some(flag) = flag {
                o.insert("checkUpdatesOnStartup".into(), flag);
            }
            v
        };
        for (theme, mode) in [("system", ThemeMode::System), ("light", ThemeMode::Light), ("dark", ThemeMode::Dark)] {
            for flag in [true, false] {
                let got = AppSettings::from_json_strict(&with(Some(json!(theme)), Some(json!(flag)))).expect("valid");
                assert_eq!(got.theme, mode);
                assert_eq!(got.check_updates_on_startup, flag);
                assert_eq!((got.part_size_mib, got.max_concurrent_parts, got.max_concurrent_transfers), (None, 8, 4));
            }
        }
        let f = Some(json!(false));
        let bad = [
            (with(Some(json!("purple")), f.clone()), "theme"),
            (with(Some(json!("Dark")), f.clone()), "theme"),
            (with(Some(json!("")), f.clone()), "theme"),
            (with(Some(json!(1)), f.clone()), "theme"),
            (with(Some(serde_json::Value::Null), f.clone()), "theme"),
            (with(None, f.clone()), "theme"),
            (with(Some(json!("dark")), Some(json!("true"))), "checkUpdatesOnStartup"),
            (with(Some(json!("dark")), Some(json!(1))), "checkUpdatesOnStartup"),
            (with(Some(json!("dark")), Some(serde_json::Value::Null)), "checkUpdatesOnStartup"),
            (with(Some(json!("dark")), None), "checkUpdatesOnStartup"),
        ];
        for (v, field) in bad {
            let e = AppSettings::from_json_strict(&v).expect_err(&v.to_string());
            assert_eq!(e.code, ErrorCode::InvalidInput);
            assert!(e.message.starts_with(field), "{v} -> {}", e.message);
        }
    }

    #[test]
    fn strict_parse_notify_flag() {
        let with = |flag: Option<serde_json::Value>| {
            let mut v = full(json!({"partSizeMib": null, "maxConcurrentParts": 8, "maxConcurrentTransfers": 4}));
            let o = v.as_object_mut().expect("object");
            match flag {
                Some(flag) => o.insert("notifyOnFinish".into(), flag),
                None => o.remove("notifyOnFinish"),
            };
            v
        };
        for flag in [true, false] {
            let got = AppSettings::from_json_strict(&with(Some(json!(flag)))).expect("valid");
            assert_eq!(got.notify_on_finish, flag);
        }
        for bad in [Some(json!("true")), Some(json!(1)), Some(serde_json::Value::Null), None] {
            let v = with(bad);
            let e = AppSettings::from_json_strict(&v).expect_err(&v.to_string());
            assert_eq!(e.code, ErrorCode::InvalidInput);
            assert!(e.message.starts_with("notifyOnFinish"), "{v} -> {}", e.message);
        }
    }

    #[test]
    fn text_size_and_weight_bounds() {
        let with = |field: &str, value: serde_json::Value| {
            let mut v = full(json!({"partSizeMib": null, "maxConcurrentParts": 8, "maxConcurrentTransfers": 4}));
            v.as_object_mut().expect("object").insert(field.into(), value);
            v
        };
        for (field, min, max) in [("textSize", 80, 150), ("textWeight", 300, 600)] {
            for ok in [min, max] {
                assert!(AppSettings::from_json_strict(&with(field, json!(ok))).is_ok(), "{field} {ok}");
            }
            for bad in [json!(min - 1), json!(max + 1), json!(100.5), json!("100"), serde_json::Value::Null] {
                let v = with(field, bad);
                let e = AppSettings::from_json_strict(&v).expect_err(&v.to_string());
                assert_eq!(e.code, ErrorCode::InvalidInput);
                assert!(e.message.starts_with(field), "{v} -> {}", e.message);
                // The on-disk file is read leniently: the bad field alone falls back to its default.
                assert_eq!(AppSettings::from_json_lenient(&v), AppSettings::default(), "{v}");
            }
        }
        let got = AppSettings::from_json_strict(&with("textSize", json!(125))).expect("valid");
        assert_eq!((got.text_size, got.text_weight), (125, 400));
    }

    #[test]
    fn file_manager_command() {
        let with = |value: Option<serde_json::Value>| {
            let mut v = full(json!({"partSizeMib": null, "maxConcurrentParts": 8, "maxConcurrentTransfers": 4}));
            let o = v.as_object_mut().expect("object");
            match value {
                Some(value) => o.insert("fileManagerCommand".into(), value),
                None => o.remove("fileManagerCommand"),
            };
            v
        };
        assert_eq!(AppSettings::default().file_manager_command, None);
        let cmd = r#""C:\Program Files\totalcmd\TOTALCMD64.EXE" /O /T "{dir}""#;
        for (value, expected) in [
            (json!(cmd), Some(cmd.to_string())),
            (json!(format!("  {cmd}\t ")), Some(cmd.to_string())),
            (json!("   "), None),
            (json!(""), None),
            (serde_json::Value::Null, None),
            (json!("x".repeat(1024)), Some("x".repeat(1024))),
            (json!("ü".repeat(1024)), Some("ü".repeat(1024))),
        ] {
            let got = AppSettings::from_json_strict(&with(Some(value.clone()))).expect("valid");
            assert_eq!(got.file_manager_command, expected, "{value}");
            assert_eq!(AppSettings::from_json_lenient(&with(Some(value.clone()))).file_manager_command, expected, "{value}");
        }
        // update_settings requires it; the on-disk file without it loads null.
        assert!(AppSettings::from_json_strict(&with(None)).expect_err("missing").message.starts_with("fileManagerCommand"));
        assert_eq!(AppSettings::from_json_lenient(&with(None)).file_manager_command, None);
        for bad in [json!("x".repeat(1025)), json!("a\nb"), json!("a\u{0}b"), json!("a\u{7f}"), json!(1), json!(true)] {
            let v = with(Some(bad.clone()));
            let e = AppSettings::from_json_strict(&v).expect_err(&v.to_string());
            assert_eq!(e.code, ErrorCode::InvalidInput);
            assert!(e.message.starts_with("fileManagerCommand"), "{bad} -> {}", e.message);
            // Leniently: only this field falls back.
            assert_eq!(AppSettings::from_json_lenient(&v), AppSettings::default(), "{bad}");
        }
        // validate() (the in-memory update path) refuses what the strict parse refuses.
        let bad = AppSettings { file_manager_command: Some("a\u{1b}b".into()), ..AppSettings::default() };
        assert!(bad.validate().is_err());
        let untrimmed = AppSettings { file_manager_command: Some(" x ".into()), ..AppSettings::default() };
        assert!(untrimmed.validate().is_err(), "the stored value is always normalized");
        assert_eq!(untrimmed.sanitized().file_manager_command.as_deref(), Some("x"));
        // Round trip through the file.
        let dir = temp_dir("file-manager");
        let path = dir.join(SETTINGS_FILE);
        let saved = AppSettings { file_manager_command: Some(cmd.into()), ..AppSettings::default() };
        save(&path, &saved).expect("save");
        assert!(std::fs::read_to_string(&path).expect("read").contains("\"fileManagerCommand\""));
        assert_eq!(load(&path), saved);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn confirm_copy_move_flag() {
        let with = |flag: Option<serde_json::Value>| {
            let mut v = full(json!({"partSizeMib": null, "maxConcurrentParts": 8, "maxConcurrentTransfers": 4}));
            let o = v.as_object_mut().expect("object");
            match flag {
                Some(flag) => o.insert("confirmCopyMove".into(), flag),
                None => o.remove("confirmCopyMove"),
            };
            v
        };
        assert!(AppSettings::default().confirm_copy_move);
        for flag in [true, false] {
            let got = AppSettings::from_json_strict(&with(Some(json!(flag)))).expect("valid");
            assert_eq!(got.confirm_copy_move, flag);
            assert_eq!(AppSettings::from_json_lenient(&with(Some(json!(flag)))).confirm_copy_move, flag);
        }
        // update_settings requires it; the on-disk file falls back to true on its own.
        for bad in [Some(json!("false")), Some(json!(0)), Some(serde_json::Value::Null), None] {
            let v = with(bad);
            let e = AppSettings::from_json_strict(&v).expect_err(&v.to_string());
            assert_eq!(e.code, ErrorCode::InvalidInput);
            assert_eq!(e.message, "confirmCopyMove must be true or false");
            assert_eq!(AppSettings::from_json_lenient(&v), AppSettings::default(), "{v}");
        }
        // false with another field invalid: only the invalid field resets.
        let mut v = with(Some(json!(false)));
        v.as_object_mut().expect("object").insert("textSize".into(), json!(9999));
        let got = AppSettings::from_json_lenient(&v);
        assert!(!got.confirm_copy_move);
        assert_eq!(got.text_size, 100);
    }

    #[test]
    fn loads_literal_redesign_file_without_confirm_copy_move() {
        let dir = temp_dir("redesign9");
        let path = dir.join(SETTINGS_FILE);
        // Exactly what v0.3.x + the redesign wrote: nine fields, no confirmCopyMove.
        std::fs::write(
            &path,
            "{
  \"partSizeMib\": 64,
  \"maxConcurrentParts\": 6,
  \"maxConcurrentTransfers\": 2,
  \"theme\": \"dark\",
  \"checkUpdatesOnStartup\": true,
  \"notifyOnFinish\": false,
  \"textSize\": 110,
  \"textWeight\": 500,
  \"accent\": \"blue\"
}",
        )
        .expect("write");
        assert_eq!(
            load(&path),
            AppSettings {
                part_size_mib: Some(64),
                max_concurrent_parts: 6,
                max_concurrent_transfers: 2,
                theme: ThemeMode::Dark,
                check_updates_on_startup: true,
                notify_on_finish: false,
                text_size: 110,
                text_weight: 500,
                accent: AccentColor::Blue,
                confirm_copy_move: true,
                file_manager_command: None,
            }
        );
        // Saved again, the file carries the new field.
        let saved = AppSettings { confirm_copy_move: false, ..load(&path) };
        save(&path, &saved).expect("save");
        let text = std::fs::read_to_string(&path).expect("read");
        assert!(text.contains("\"confirmCopyMove\": false"), "{text}");
        assert_eq!(load(&path), saved);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn accent_is_one_of_four_colours() {
        let with = |value: serde_json::Value| {
            let mut v = full(json!({"partSizeMib": null, "maxConcurrentParts": 8, "maxConcurrentTransfers": 4}));
            v.as_object_mut().expect("object").insert("accent".into(), value);
            v
        };
        let colours =
            [("yellow", AccentColor::Yellow), ("green", AccentColor::Green), ("blue", AccentColor::Blue), ("red", AccentColor::Red)];
        for (name, colour) in colours {
            assert_eq!(AppSettings::from_json_strict(&with(json!(name))).expect("valid").accent, colour);
            assert_eq!(AppSettings::from_json_lenient(&with(json!(name))).accent, colour);
        }
        for bad in [json!("purple"), json!("Blue"), json!(""), json!(1), serde_json::Value::Null] {
            let v = with(bad);
            let e = AppSettings::from_json_strict(&v).expect_err(&v.to_string());
            assert_eq!(e.code, ErrorCode::InvalidInput);
            assert!(e.message.starts_with("accent"), "{v} -> {}", e.message);
            // The on-disk file is read leniently: an unknown colour falls back to yellow.
            assert_eq!(AppSettings::from_json_lenient(&v), AppSettings::default(), "{v}");
        }
    }

    #[test]
    fn loads_literal_v020_file() {
        let dir = temp_dir("v020");
        let path = dir.join(SETTINGS_FILE);
        // Exactly what v0.2.0's `save` wrote (serde_json pretty, three fields).
        std::fs::write(&path, "{\n  \"partSizeMib\": 32,\n  \"maxConcurrentParts\": 12,\n  \"maxConcurrentTransfers\": 3\n}")
            .expect("write");
        assert_eq!(
            load(&path),
            AppSettings {
                part_size_mib: Some(32),
                max_concurrent_parts: 12,
                max_concurrent_transfers: 3,
                theme: ThemeMode::System,
                check_updates_on_startup: false,
                notify_on_finish: true,
                text_size: 100,
                text_weight: 400,
                accent: AccentColor::Yellow,
                confirm_copy_move: true,
                file_manager_command: None,
            }
        );
        std::fs::write(&path, "{\n  \"partSizeMib\": null,\n  \"maxConcurrentParts\": 8,\n  \"maxConcurrentTransfers\": 4\n}")
            .expect("write");
        assert_eq!(load(&path), AppSettings::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lenient_load_resets_only_bad_fields() {
        let dir = temp_dir("lenient");
        let path = dir.join(SETTINGS_FILE);
        let cases = [
            // Unknown theme: only the theme falls back.
            (
                r#"{"partSizeMib": 4, "maxConcurrentParts": 2, "maxConcurrentTransfers": 1, "theme": "purple", "checkUpdatesOnStartup": true}"#,
                AppSettings {
                    part_size_mib: Some(4),
                    max_concurrent_parts: 2,
                    max_concurrent_transfers: 1,
                    theme: ThemeMode::System,
                    check_updates_on_startup: true,
                    notify_on_finish: true,
                    text_size: 100,
                    text_weight: 400,
                    accent: AccentColor::Yellow,
                    confirm_copy_move: true,
                    file_manager_command: None,
                },
            ),
            // Non-boolean flag: only the flag falls back.
            (
                r#"{"partSizeMib": 4, "theme": "dark", "checkUpdatesOnStartup": "yes"}"#,
                AppSettings { part_size_mib: Some(4), theme: ThemeMode::Dark, ..AppSettings::default() },
            ),
            // Wrong-typed transfer field next to valid new fields.
            (
                r#"{"maxConcurrentParts": "eight", "maxConcurrentTransfers": 2, "theme": "light"}"#,
                AppSettings { max_concurrent_transfers: 2, theme: ThemeMode::Light, ..AppSettings::default() },
            ),
            // Fractional / negative numbers.
            (
                r#"{"partSizeMib": 2.5, "maxConcurrentParts": -1, "checkUpdatesOnStartup": true}"#,
                AppSettings { check_updates_on_startup: true, ..AppSettings::default() },
            ),
            // Notifications switched off; a non-boolean value falls back to on.
            (r#"{"notifyOnFinish": false}"#, AppSettings { notify_on_finish: false, ..AppSettings::default() }),
            (r#"{"notifyOnFinish": "no"}"#, AppSettings::default()),
        ];
        for (text, want) in cases {
            std::fs::write(&path, text).expect("write");
            assert_eq!(load(&path), want, "{text}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn new_fields_round_trip_through_file() {
        let dir = temp_dir("newfields");
        let path = dir.join(SETTINGS_FILE);
        let v = AppSettings { theme: ThemeMode::Dark, check_updates_on_startup: true, ..s(Some(8), 4, 2) };
        save(&path, &v).expect("save");
        let text = std::fs::read_to_string(&path).expect("read");
        assert!(text.contains("\"theme\": \"dark\"") && text.contains("\"checkUpdatesOnStartup\": true"), "{text}");
        assert_eq!(load(&path), v);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_round_trip() {
        let dir = temp_dir("roundtrip");
        // Directory is created on save if missing.
        let path = dir.join("nested").join(SETTINGS_FILE);
        let v = s(Some(32), 16, 2);
        save(&path, &v).expect("save");
        assert_eq!(load(&path), v);
        // Overwrite an existing file.
        let v2 = s(None, 1, 10);
        save(&path, &v2).expect("save again");
        assert_eq!(load(&path), v2);
        // No temp files left behind.
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().expect("parent"))
            .expect("read dir")
            .filter_map(Result::ok)
            .map(|e| e.file_name())
            .collect();
        assert_eq!(leftovers, vec![std::ffi::OsString::from(SETTINGS_FILE)]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_corrupt_partial_and_out_of_range_files() {
        let dir = temp_dir("load");
        let path = dir.join(SETTINGS_FILE);
        assert_eq!(load(&path), AppSettings::default(), "missing");

        for corrupt in ["", "{", "not json", "[]", r#"{"maxConcurrentParts":"eight"}"#, r#"{"partSizeMib":-3}"#] {
            std::fs::write(&path, corrupt).expect("write");
            assert_eq!(load(&path), AppSettings::default(), "corrupt: {corrupt}");
        }

        std::fs::write(&path, r#"{"maxConcurrentParts": 3, "futureField": {"x": 1}}"#).expect("write");
        assert_eq!(load(&path), s(None, 3, 4), "partial + unknown field");

        std::fs::write(&path, r#"{"partSizeMib": 999, "maxConcurrentParts": 0, "maxConcurrentTransfers": 2}"#)
            .expect("write");
        assert_eq!(load(&path), s(None, 8, 2), "out-of-range fields fall back individually");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn store_update_persists_and_applies() {
        let dir = temp_dir("store");
        let path = dir.join(SETTINGS_FILE);
        let store = SettingsStore::load(path.clone());
        assert_eq!(store.get(), AppSettings::default());

        let mut applied = None;
        let v = s(Some(4), 3, 1);
        assert_eq!(store.update(v.clone(), |x| applied = Some(x.clone())).await.expect("update"), v);
        assert_eq!(applied, Some(v.clone()));
        assert_eq!(store.get(), v);
        assert_eq!(SettingsStore::load(path.clone()).get(), v, "reloaded from disk");

        // Invalid: rejected, nothing changes, apply not called.
        let mut called = false;
        let e = store.update(s(Some(0), 3, 1), |_| called = true).await.expect_err("invalid");
        assert_eq!(e.code, ErrorCode::InvalidInput);
        assert!(!called);
        assert_eq!(store.get(), v);
        assert_eq!(load(&path), v);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn store_update_disk_failure_keeps_memory() {
        let dir = temp_dir("fail");
        // A regular file where the config directory should be makes create_dir_all fail.
        let blocker = dir.join("blocker");
        std::fs::write(&blocker, b"x").expect("write");
        let store = SettingsStore::load(blocker.join(SETTINGS_FILE));
        let mut called = false;
        let e = store.update(s(Some(4), 3, 1), |_| called = true).await.expect_err("io");
        assert_eq!(e.code, ErrorCode::Io);
        assert!(!called);
        assert_eq!(store.get(), AppSettings::default());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
