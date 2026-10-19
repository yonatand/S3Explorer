//! v0.9.0 "Window icon follows the accent": the bundled icon of each accent colour.
//!
//! The PNGs are compiled into the executable (no file access): a 32 px one for the title bar and a
//! 256 px one for the taskbar / Alt-Tab (and the only one used on macOS and Linux).

use crate::error::{AppError, AppResult};
use crate::models::AccentColor;

/// The accent named by the frontend, `InvalidInput` for anything else.
pub fn parse_accent(name: &str) -> AppResult<AccentColor> {
    AccentColor::parse(name)
        .ok_or_else(|| AppError::invalid(format!(r#"accent must be "yellow", "green", "blue" or "red", not {name:?}"#)))
}

/// (32 px, 256 px) PNG bytes for `accent`.
pub fn icon_png(accent: AccentColor) -> (&'static [u8], &'static [u8]) {
    match accent {
        AccentColor::Yellow => {
            (include_bytes!("../icons/accent/yellow-32.png"), include_bytes!("../icons/accent/yellow-256.png"))
        }
        AccentColor::Green => (include_bytes!("../icons/accent/green-32.png"), include_bytes!("../icons/accent/green-256.png")),
        AccentColor::Blue => (include_bytes!("../icons/accent/blue-32.png"), include_bytes!("../icons/accent/blue-256.png")),
        AccentColor::Red => (include_bytes!("../icons/accent/red-32.png"), include_bytes!("../icons/accent/red-256.png")),
    }
}

/// Decodes one bundled PNG (`Io`-free: the bytes are in the executable).
pub fn decode(png: &'static [u8]) -> AppResult<tauri::image::Image<'static>> {
    tauri::image::Image::from_bytes(png).map_err(|e| AppError::new(crate::error::ErrorCode::Unknown, format!("Bundled icon is unreadable: {e}")))
}

/// Gives `window` the icons of `accent`. On Windows this must run on the main (window) thread:
/// the title-bar, taskbar and window-class icons are set there in one go (see
/// `windows_shell::set_window_icons_rgba`). Elsewhere the 256 px icon goes through Tauri.
pub fn apply<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>, accent: AccentColor) -> AppResult<()> {
    let (small, big) = icon_png(accent);
    let failed = |e: tauri::Error| AppError::new(crate::error::ErrorCode::Unknown, format!("Could not set the window icon: {e}"));
    #[cfg(windows)]
    {
        let (small, big) = (decode(small)?, decode(big)?);
        let hwnd = window.hwnd().map_err(failed)?.0 as isize;
        // v0.9.2: first the window's own AppUserModelID, one per accent, so no Start-menu shortcut
        // matches it and the taskbar draws the button from the window's icons. Never fatal.
        {
            use tauri::Manager;
            let id = window_app_id(&window.app_handle().config().identifier, accent);
            if let Err(m) = crate::windows_shell::set_window_app_id(hwnd, &id) {
                eprintln!("Could not set the window's AppUserModelID: {m}");
            }
        }
        crate::windows_shell::set_window_icons_rgba(
            hwnd,
            (small.rgba(), small.width(), small.height()),
            (big.rgba(), big.width(), big.height()),
        )
        .map_err(|m| AppError::new(crate::error::ErrorCode::Unknown, format!("Could not set the window icon: {m}")))?;
        // v0.9.2: after the window and class icons. Never fatal: the title bar is already right.
        if let Err(m) = set_relaunch_icon(window, hwnd, accent) {
            eprintln!("Could not set the taskbar relaunch icon: {m}");
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = small;
        window.set_icon(decode(big)?).map_err(failed)
    }
}

/// v0.9.2: the name the taskbar shows for the relaunch command (`RelaunchDisplayNameResource`).
pub const RELAUNCH_DISPLAY_NAME: &str = "S3 Explorer";

/// The accent's file name stem (`icons\<accent>.ico`), the same word the frontend uses.
pub fn accent_name(accent: AccentColor) -> &'static str {
    match accent {
        AccentColor::Yellow => "yellow",
        AccentColor::Green => "green",
        AccentColor::Blue => "blue",
        AccentColor::Red => "red",
    }
}

/// Where the accent's `.ico` lives: `<app config dir>\icons\<accent>.ico`.
pub fn accent_ico_path(config_dir: &std::path::Path, accent: AccentColor) -> std::path::PathBuf {
    config_dir.join("icons").join(format!("{}.ico", accent_name(accent)))
}

/// A PNG-in-ICO container (Vista+): the 6-byte `ICONDIR`, one 16-byte `ICONDIRENTRY` per image
/// (`(size in px, PNG bytes)`, square, 32 bpp; 256 is written as 0), then the PNGs in order.
pub fn ico_container(images: &[(u32, &[u8])]) -> Vec<u8> {
    let header = 6 + 16 * images.len();
    let mut out = Vec::with_capacity(header + images.iter().map(|(_, p)| p.len()).sum::<usize>());
    out.extend_from_slice(&0u16.to_le_bytes()); // reserved
    out.extend_from_slice(&1u16.to_le_bytes()); // type: icon
    out.extend_from_slice(&(images.len() as u16).to_le_bytes());
    let mut offset = header as u32;
    for (size, png) in images {
        let dim = if *size >= 256 { 0 } else { *size as u8 };
        out.extend_from_slice(&[dim, dim, 0, 0]); // width, height, palette size, reserved
        out.extend_from_slice(&1u16.to_le_bytes()); // planes
        out.extend_from_slice(&32u16.to_le_bytes()); // bits per pixel
        out.extend_from_slice(&(png.len() as u32).to_le_bytes());
        out.extend_from_slice(&offset.to_le_bytes());
        offset += png.len() as u32;
    }
    for (_, png) in images {
        out.extend_from_slice(png);
    }
    out
}

/// The `.ico` bytes of `accent` (32 px and 256 px entries).
pub fn accent_ico(accent: AccentColor) -> Vec<u8> {
    let (small, big) = icon_png(accent);
    ico_container(&[(32, small), (256, big)])
}

/// Writes `bytes` to `path` only when the file is missing or different, atomically (a temp file
/// beside it, then a rename over it). `true` when it wrote.
pub fn write_if_changed(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<bool> {
    use std::io::Write;
    if std::fs::read(path).is_ok_and(|old| old == bytes) {
        return Ok(false);
    }
    let dir = path.parent().ok_or_else(|| std::io::Error::other("the icon path has no folder"))?;
    std::fs::create_dir_all(dir)?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    let written = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(true)
}

/// v0.9.2: the main window's AppUserModelID, `<identifier>.<accent>` (e.g. `dev.s3explorer.app.blue`).
/// The process keeps the plain identifier (notifications are sent under it).
pub fn window_app_id(identifier: &str, accent: AccentColor) -> String {
    format!("{identifier}.{}", accent_name(accent))
}

/// `RelaunchIconResource`: the `.ico` file, icon index 0.
pub fn relaunch_icon_resource(ico: &std::path::Path) -> Option<String> {
    Some(format!("{},0", ico.to_str()?))
}

/// `RelaunchCommand`: the executable's path, quoted (no arguments).
pub fn relaunch_command(exe: &std::path::Path) -> Option<String> {
    Some(format!("\"{}\"", exe.to_str()?))
}

/// v0.9.2 "Taskbar icon follows the accent": the relaunch properties make "Pin to taskbar" on the
/// running window pin the accent's icon (the `.ico` written to the config dir) and relaunch this
/// executable. Main thread (needs the window).
#[cfg(windows)]
fn set_relaunch_icon<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>, hwnd: isize, accent: AccentColor) -> Result<(), String> {
    use tauri::Manager;
    let app = window.app_handle();
    let dir = app.path().app_config_dir().map_err(|e| format!("no config folder: {e}"))?;
    let ico = accent_ico_path(&dir, accent);
    write_if_changed(&ico, &accent_ico(accent)).map_err(|e| format!("could not write {}: {e}", ico.display()))?;
    let exe = tauri::utils::platform::current_exe().map_err(|e| format!("no executable path: {e}"))?;
    let icon = relaunch_icon_resource(&ico).ok_or("the icon path is not Unicode")?;
    let command = relaunch_command(&exe).ok_or("the executable path is not Unicode")?;
    crate::windows_shell::set_relaunch_properties(hwnd, &icon, &command, RELAUNCH_DISPLAY_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    #[test]
    fn accents_parse_and_others_are_invalid() {
        for (name, want) in [
            ("yellow", AccentColor::Yellow),
            ("green", AccentColor::Green),
            ("blue", AccentColor::Blue),
            ("red", AccentColor::Red),
        ] {
            assert_eq!(parse_accent(name).expect(name), want);
        }
        for bad in ["", "Yellow", "purple", " red", "red "] {
            assert_eq!(parse_accent(bad).expect_err(bad).code, ErrorCode::InvalidInput, "{bad:?}");
        }
    }

    fn u16_at(b: &[u8], i: usize) -> u16 {
        u16::from_le_bytes([b[i], b[i + 1]])
    }
    fn u32_at(b: &[u8], i: usize) -> u32 {
        u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
    }

    #[test]
    fn ico_container_has_header_entries_and_png_payloads() {
        for accent in [AccentColor::Yellow, AccentColor::Green, AccentColor::Blue, AccentColor::Red] {
            let (small, big) = icon_png(accent);
            let ico = accent_ico(accent);
            assert_eq!((u16_at(&ico, 0), u16_at(&ico, 2), u16_at(&ico, 4)), (0, 1, 2), "{accent:?} header");
            assert_eq!(ico.len(), 6 + 32 + small.len() + big.len());
            let mut expected_offset = 6 + 32;
            for (i, (png, size, dim)) in [(small, 32u32, 32u8), (big, 256, 0)].into_iter().enumerate() {
                let e = 6 + 16 * i;
                assert_eq!(&ico[e..e + 4], &[dim, dim, 0, 0], "{accent:?} entry {i}");
                assert_eq!((u16_at(&ico, e + 4), u16_at(&ico, e + 6)), (1, 32), "planes / bpp");
                let len = u32_at(&ico, e + 8) as usize;
                let off = u32_at(&ico, e + 12) as usize;
                assert_eq!((len, off), (png.len(), expected_offset), "{accent:?} entry {i}");
                expected_offset += len;
                let payload = &ico[off..off + len];
                assert_eq!(payload, png);
                // Each payload parses back as the PNG of the size its entry claims.
                let leaked: &'static [u8] = Box::leak(payload.to_vec().into_boxed_slice());
                let img = decode(leaked).unwrap_or_else(|e| panic!("{accent:?} {size}: {}", e.message));
                assert_eq!((img.width(), img.height()), (size, size));
            }
        }
        // 256 and above are written as 0; smaller sizes as themselves.
        let one = ico_container(&[(48, b"abc")]);
        assert_eq!((one[6], one[7], u32_at(&one, 14), u32_at(&one, 18)), (48, 48, 3, 22));
        assert_eq!(&one[22..], b"abc");
        assert_eq!(ico_container(&[]), vec![0, 0, 1, 0, 0, 0]);
    }

    #[test]
    fn ico_path_and_relaunch_values() {
        let dir = std::path::Path::new(r"C:\Users\A B\AppData\Roaming\dev.s3explorer.app");
        let ico = accent_ico_path(dir, AccentColor::Blue);
        assert_eq!(ico, dir.join("icons").join("blue.ico"));
        assert_eq!(
            relaunch_icon_resource(&ico).as_deref(),
            Some(r"C:\Users\A B\AppData\Roaming\dev.s3explorer.app\icons\blue.ico,0")
        );
        let exe = std::path::Path::new(r"C:\Program Files\S3 Explorer\s3explorer.exe");
        assert_eq!(relaunch_command(exe).as_deref(), Some(r#""C:\Program Files\S3 Explorer\s3explorer.exe""#));
        assert_eq!(RELAUNCH_DISPLAY_NAME, "S3 Explorer");
        assert_eq!(window_app_id("dev.s3explorer.app", AccentColor::Blue), "dev.s3explorer.app.blue");
        assert_eq!(window_app_id("dev.s3explorer.app", AccentColor::Yellow), "dev.s3explorer.app.yellow");
        for accent in [AccentColor::Yellow, AccentColor::Green, AccentColor::Blue, AccentColor::Red] {
            assert_eq!(AccentColor::parse(accent_name(accent)), Some(accent));
        }
    }

    #[test]
    fn ico_is_written_once_and_rewritten_only_when_different() {
        let dir = std::env::temp_dir().join(format!("s3x-ico-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = accent_ico_path(&dir, AccentColor::Green);
        let bytes = accent_ico(AccentColor::Green);
        assert!(write_if_changed(&path, &bytes).expect("first write"), "missing file is written");
        assert_eq!(std::fs::read(&path).expect("read"), bytes);
        let before = std::fs::metadata(&path).and_then(|m| m.modified()).expect("mtime");
        std::thread::sleep(std::time::Duration::from_millis(20));
        assert!(!write_if_changed(&path, &bytes).expect("second"), "same bytes are not rewritten");
        assert_eq!(std::fs::metadata(&path).and_then(|m| m.modified()).expect("mtime"), before);
        std::fs::write(&path, b"stale").expect("corrupt");
        assert!(write_if_changed(&path, &bytes).expect("third"), "different bytes are rewritten");
        assert_eq!(std::fs::read(&path).expect("read"), bytes);
        // No temp file is left behind.
        let names: Vec<_> =
            std::fs::read_dir(path.parent().expect("dir")).expect("ls").map(|e| e.expect("entry").file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("green.ico")]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn all_eight_bundled_icons_decode_as_png() {
        for accent in [AccentColor::Yellow, AccentColor::Green, AccentColor::Blue, AccentColor::Red] {
            let (small, big) = icon_png(accent);
            for (png, size) in [(small, 32), (big, 256)] {
                assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"), "{accent:?} {size}: not a PNG");
                let img = decode(png).unwrap_or_else(|e| panic!("{accent:?} {size}: {}", e.message));
                assert_eq!((img.width(), img.height()), (size, size), "{accent:?}");
                assert_eq!(img.rgba().len(), (size * size * 4) as usize);
            }
        }
    }
}
