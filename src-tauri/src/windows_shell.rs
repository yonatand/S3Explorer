//! How the Windows shell identifies the app: the taskbar icon of the window and the process's
//! AppUserModelID. Both are no-ops on other platforms.
//!
//! Tauri sets only the window's small icon (`ICON_SMALL`, drawn in the title bar) and leaves the
//! large icon (`ICON_BIG`) and the window class icons empty. With no large icon the taskbar falls
//! back to the icon the shell has cached for the executable path or its shortcut, which survives an
//! upgrade in place and keeps showing the icon of the previously installed version.
//!
//! The installers stamp `System.AppUserModel.ID = <bundle identifier>` on the Start menu and
//! desktop shortcuts, but the process itself had no explicit AppUserModelID, so a launch that does
//! not go through a shortcut (the installer's "Run" checkbox, the restart after an in-app update)
//! was not tied to the pinned shortcut.
//!
//! v0.9.2: with that ID the taskbar takes the running button's icon from the Start-menu shortcut
//! unless the window's property store names a relaunch icon ([`set_relaunch_properties`]).

/// Sets the process-wide AppUserModelID to the bundle identifier, matching the ID the installers
/// write on the shortcuts. Must run before the first window is created.
///
/// Skipped for builds run from `target\debug` or `target\release`, the same rule
/// `tauri-plugin-notification` uses, so a development build is never grouped with (or shown under
/// the pinned shortcut of) the installed app.
pub fn set_app_user_model_id(identifier: &str) {
    #[cfg(windows)]
    {
        if running_from_cargo_target() {
            return;
        }
        let wide: Vec<u16> = identifier
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: `wide` is a NUL-terminated UTF-16 string that outlives the call; the function
        // copies it.
        let hr = unsafe { ffi::SetCurrentProcessExplicitAppUserModelID(wide.as_ptr()) };
        if hr < 0 {
            log_failure("SetCurrentProcessExplicitAppUserModelID", hr as i64);
        }
    }
    #[cfg(not(windows))]
    let _ = identifier;
}

/// Gives every open window the application icon resource as its large (taskbar / Alt+Tab) icon,
/// loaded from this executable so it is always the icon of the running version.
pub fn set_taskbar_icons<R: tauri::Runtime>(app: &tauri::App<R>) {
    #[cfg(windows)]
    {
        use tauri::Manager;
        for window in app.webview_windows().values() {
            match window.hwnd() {
                Ok(hwnd) => set_big_icon(hwnd.0 as isize),
                Err(e) => eprintln!("could not get the window handle to set the taskbar icon: {e}"),
            }
        }
    }
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(windows)]
fn set_big_icon(hwnd: isize) {
    // SAFETY: plain Win32 calls. A null module handle means this executable; the resource ID is
    // the one tauri-build embeds the application icon under. The icon is shared (LR_SHARED), so it
    // is owned by the system and must not be destroyed.
    unsafe {
        let width = ffi::GetSystemMetrics(ffi::SM_CXICON);
        let height = ffi::GetSystemMetrics(ffi::SM_CYICON);
        let module = ffi::GetModuleHandleW(std::ptr::null());
        let icon = ffi::LoadImageW(
            module,
            tauri::utils::platform::WINDOWS_APP_ICON_RESOURCE_ID as usize as *const u16,
            ffi::IMAGE_ICON,
            width,
            height,
            ffi::LR_SHARED,
        );
        if icon == 0 {
            log_failure("LoadImageW(application icon)", 0);
            return;
        }
        ffi::SendMessageW(hwnd, ffi::WM_SETICON, ffi::ICON_BIG, icon);
    }
}

/// The icons [`set_window_icons_rgba`] created last (0 = none), released when replaced.
#[cfg(windows)]
static CREATED: std::sync::Mutex<(isize, isize)> = std::sync::Mutex::new((0, 0));

/// An `HICON` from `rgba` (straight alpha, `width` x `height`), owned by the caller.
#[cfg(windows)]
fn icon_from_rgba(rgba: &[u8], width: u32, height: u32) -> Result<isize, String> {
    if width == 0 || height == 0 || rgba.len() != (width as usize) * (height as usize) * 4 {
        return Err("The icon image has the wrong size".into());
    }
    // Windows wants BGRA; the AND mask is all zeros (transparency comes from the alpha channel).
    let mut bgra = rgba.to_vec();
    for px in bgra.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    let mask = vec![0u8; mask_len(width, height)];
    // SAFETY: both buffers are as large as the sizes passed say.
    let icon = unsafe { ffi::CreateIcon(0, width as i32, height as i32, 1, 32, mask.as_ptr(), bgra.as_ptr()) };
    if icon == 0 {
        return Err("CreateIcon failed".into());
    }
    Ok(icon)
}

/// Bytes of a 1-bit AND mask: rows padded to 16 bits.
#[cfg(windows)]
fn mask_len(width: u32, height: u32) -> usize {
    (width as usize).div_ceil(16) * 2 * height as usize
}

/// v0.9.1 "Taskbar icon follows the accent": gives the window `small` (title bar, 32 px) and `big`
/// (taskbar / Alt+Tab, 256 px) icons, each `(rgba, width, height)`. Call on the window's thread.
///
/// The sequence, and why each step is there:
/// 1. Both icons are created first; nothing changes if either fails.
/// 2. The window class icons (`GCLP_HICON`, `GCLP_HICONSM`) are replaced: the shell falls back to
///    them whenever the window answers `WM_GETICON` with nothing, and tao registers its class
///    without any.
/// 3. `WM_SETICON` `ICON_SMALL` and `ICON_BIG` (after the class change, so the per-window icons
///    are the last thing set): `DefWindowProc` stores them and repaints the caption; the taskbar
///    asks the window for `ICON_BIG` / `ICON_SMALL2` when it redraws the button.
/// 4. The window text is set again to itself: `WM_SETTEXT` makes the system send the shell's
///    `HSHELL_REDRAW` for the window, which is what makes the taskbar re-read the button's title
///    and icon right away.
/// 5. The icons created by the previous call are destroyed (never the executable's shared icon,
///    which this function never created).
#[cfg(windows)]
pub fn set_window_icons_rgba(hwnd: isize, small: (&[u8], u32, u32), big: (&[u8], u32, u32)) -> Result<(), String> {
    let small_icon = icon_from_rgba(small.0, small.1, small.2)?;
    let big_icon = match icon_from_rgba(big.0, big.1, big.2) {
        Ok(i) => i,
        Err(e) => {
            // SAFETY: created just above and never handed to a window.
            unsafe { ffi::DestroyIcon(small_icon) };
            return Err(e);
        }
    };
    // SAFETY: plain Win32 calls on a window handle; the icons stay alive until a later call has
    // replaced them on both the window and its class.
    unsafe {
        ffi::SetClassLongPtrW(hwnd, ffi::GCLP_HICON, big_icon);
        ffi::SetClassLongPtrW(hwnd, ffi::GCLP_HICONSM, small_icon);
        ffi::SendMessageW(hwnd, ffi::WM_SETICON, ffi::ICON_SMALL, small_icon);
        ffi::SendMessageW(hwnd, ffi::WM_SETICON, ffi::ICON_BIG, big_icon);
        refresh_taskbar_button(hwnd);
    }
    let previous = {
        let mut created = CREATED.lock().unwrap_or_else(|e| e.into_inner());
        std::mem::replace(&mut *created, (small_icon, big_icon))
    };
    for icon in [previous.0, previous.1] {
        if icon != 0 {
            // SAFETY: created by an earlier call and no longer set on the window or its class.
            unsafe { ffi::DestroyIcon(icon) };
        }
    }
    Ok(())
}

/// Sets the window's text to itself so the shell gets `HSHELL_REDRAW` and repaints the taskbar
/// button (icon included).
///
/// # Safety
/// `hwnd` is a window of this thread (or 0, which makes the calls fail harmlessly).
#[cfg(windows)]
unsafe fn refresh_taskbar_button(hwnd: isize) {
    let mut buf = vec![0u16; 512];
    // SAFETY: `buf` is writable for the length passed; the result is NUL-terminated.
    let n = unsafe { ffi::GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    if n <= 0 {
        return;
    }
    buf.truncate(n as usize);
    buf.push(0);
    // SAFETY: NUL-terminated text that outlives the call.
    unsafe { ffi::SetWindowTextW(hwnd, buf.as_ptr()) };
}

/// The window's shell property store. Call on the window's thread (COM is initialized there by
/// the webview).
#[cfg(windows)]
fn window_property_store(hwnd: isize) -> Result<windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore, String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::PropertiesSystem::SHGetPropertyStoreForWindow;
    // SAFETY: a plain shell call on a window handle; an invalid handle is an error, not UB.
    unsafe { SHGetPropertyStoreForWindow(HWND(hwnd as *mut core::ffi::c_void)) }
        .map_err(|e| format!("SHGetPropertyStoreForWindow: {e}"))
}

/// The window's `System.AppUserModel.ID`, `None` when it has none (or it cannot be read).
#[cfg(windows)]
pub fn window_app_id(hwnd: isize) -> Option<String> {
    use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
    use windows::Win32::System::Variant::VT_LPWSTR;
    let store = window_property_store(hwnd).ok()?;
    // SAFETY: plain COM call; the union is read only after checking it is a VT_LPWSTR.
    unsafe {
        let pv = store.GetValue(&PKEY_AppUserModel_ID).ok()?;
        if pv.vt() != VT_LPWSTR {
            return None;
        }
        pv.Anonymous.Anonymous.Anonymous.pwszVal.to_string().ok()
    }
}

/// v0.9.2 "Taskbar icon follows the accent": gives the window its own AppUserModelID (the process
/// keeps the plain identifier). With the process ID alone the taskbar resolves the running button's
/// icon through the Start-menu shortcut carrying that ID and ignores the window's icons; a
/// per-accent window ID matches no shortcut, so the button is drawn from the window. Changing the
/// ID of an open window moves its button to the new group. Set in every build, also from the cargo
/// target dir. Nothing is written when the window already has `app_id`.
#[cfg(windows)]
pub fn set_window_app_id(hwnd: isize, app_id: &str) -> Result<(), String> {
    use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
    if window_app_id(hwnd).as_deref() == Some(app_id) {
        return Ok(());
    }
    let store = window_property_store(hwnd)?;
    let pv = lpwstr_propvariant(app_id)?;
    // SAFETY: `pv` outlives the call; the store copies the value.
    unsafe { store.SetValue(&PKEY_AppUserModel_ID, &pv) }.map_err(|e| format!("SetValue(System.AppUserModel.ID): {e}"))?;
    // SAFETY: plain COM call on a live interface.
    unsafe { store.Commit() }.map_err(|e| format!("IPropertyStore::Commit: {e}"))
}

/// v0.9.2: the relaunch properties of the window, so "Pin to taskbar" on the running window pins
/// `icon_resource` (`"<file>,<index>"`) and `command`. Windows ignores the relaunch icon unless
/// `RelaunchCommand` and `RelaunchDisplayNameResource` are set with it, and all three unless the
/// window has its own AppUserModelID ([`set_window_app_id`], set first). Call on the window's
/// thread.
#[cfg(windows)]
pub fn set_relaunch_properties(hwnd: isize, icon_resource: &str, command: &str, display_name: &str) -> Result<(), String> {
    use windows::Win32::Storage::EnhancedStorage::{
        PKEY_AppUserModel_RelaunchCommand, PKEY_AppUserModel_RelaunchDisplayNameResource,
        PKEY_AppUserModel_RelaunchIconResource,
    };
    let store = window_property_store(hwnd)?;
    let values = [
        (PKEY_AppUserModel_RelaunchCommand, "RelaunchCommand", command),
        (PKEY_AppUserModel_RelaunchDisplayNameResource, "RelaunchDisplayNameResource", display_name),
        (PKEY_AppUserModel_RelaunchIconResource, "RelaunchIconResource", icon_resource),
    ];
    for (key, name, value) in values {
        let pv = lpwstr_propvariant(value)?;
        // SAFETY: `key` and `pv` outlive the call; the store copies the value.
        unsafe { store.SetValue(&key, &pv) }.map_err(|e| format!("SetValue(System.AppUserModel.{name}): {e}"))?;
    }
    // SAFETY: plain COM call on a live interface.
    unsafe { store.Commit() }.map_err(|e| format!("IPropertyStore::Commit: {e}"))
}

/// A `VT_LPWSTR` `PROPVARIANT` holding a CoTaskMem copy of `value` (what the AppUserModel keys
/// require; `From<&str>` would make a `VT_BSTR`). Freed by `PropVariantClear` on drop.
#[cfg(windows)]
fn lpwstr_propvariant(value: &str) -> Result<windows::Win32::System::Com::StructuredStorage::PROPVARIANT, String> {
    use windows::core::PCWSTR;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::SHStrDupW;

    let wide: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: `wide` is NUL-terminated and outlives the call; the copy is CoTaskMem-allocated.
    let copy = unsafe { SHStrDupW(PCWSTR(wide.as_ptr())) }.map_err(|e| format!("SHStrDupW: {e}"))?;
    let mut pv = PROPVARIANT::default();
    // SAFETY: a default PROPVARIANT is VT_EMPTY; the union is set to a VT_LPWSTR that owns `copy`,
    // which PropVariantClear (on drop) frees with CoTaskMemFree.
    unsafe {
        let inner = &mut pv.Anonymous.Anonymous;
        inner.vt = VT_LPWSTR;
        inner.Anonymous.pwszVal = copy;
    }
    Ok(pv)
}

#[cfg(windows)]
fn running_from_cargo_target() -> bool {
    let Ok(exe) = tauri::utils::platform::current_exe() else {
        return false;
    };
    exe.parent().is_some_and(|dir| {
        dir.ends_with(std::path::Path::new("target").join("debug"))
            || dir.ends_with(std::path::Path::new("target").join("release"))
    })
}

#[cfg(windows)]
fn log_failure(what: &str, code: i64) {
    // No logger is installed; stderr is visible in development and harmless in release.
    eprintln!("{what} failed (code {code:#x})");
}

#[cfg(windows)]
#[allow(non_snake_case)]
mod ffi {
    pub const SM_CXICON: i32 = 11;
    pub const SM_CYICON: i32 = 12;
    pub const IMAGE_ICON: u32 = 1;
    pub const LR_SHARED: u32 = 0x8000;
    pub const WM_SETICON: u32 = 0x0080;
    pub const ICON_SMALL: usize = 0;
    pub const ICON_BIG: usize = 1;
    pub const GCLP_HICON: i32 = -14;
    pub const GCLP_HICONSM: i32 = -34;

    #[link(name = "user32")]
    extern "system" {
        pub fn GetSystemMetrics(index: i32) -> i32;
        pub fn LoadImageW(
            instance: isize,
            name: *const u16,
            kind: u32,
            cx: i32,
            cy: i32,
            load: u32,
        ) -> isize;
        pub fn SendMessageW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize;
        pub fn CreateIcon(
            instance: isize,
            width: i32,
            height: i32,
            planes: u8,
            bits_per_pixel: u8,
            and_bits: *const u8,
            xor_bits: *const u8,
        ) -> isize;
        pub fn DestroyIcon(icon: isize) -> i32;
        pub fn SetClassLongPtrW(hwnd: isize, index: i32, value: isize) -> usize;
        pub fn GetWindowTextW(hwnd: isize, text: *mut u16, max: i32) -> i32;
        pub fn SetWindowTextW(hwnd: isize, text: *const u16) -> i32;
        #[cfg(test)]
        pub fn CreateWindowExW(
            ex_style: u32,
            class: *const u16,
            name: *const u16,
            style: u32,
            x: i32,
            y: i32,
            w: i32,
            h: i32,
            parent: isize,
            menu: isize,
            instance: isize,
            param: *const core::ffi::c_void,
        ) -> isize;
        #[cfg(test)]
        pub fn DestroyWindow(hwnd: isize) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetModuleHandleW(name: *const u16) -> isize;
    }

    #[link(name = "shell32")]
    extern "system" {
        pub fn SetCurrentProcessExplicitAppUserModelID(id: *const u16) -> i32;
        #[cfg(test)]
        pub fn GetCurrentProcessExplicitAppUserModelID(id: *mut *mut u16) -> i32;
    }

    #[cfg(test)]
    #[link(name = "ole32")]
    extern "system" {
        pub fn CoTaskMemFree(ptr: *mut core::ffi::c_void);
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn current_id() -> Option<String> {
        let mut ptr: *mut u16 = std::ptr::null_mut();
        // SAFETY: on success the shell allocates a NUL-terminated string we free with CoTaskMemFree.
        unsafe {
            if ffi::GetCurrentProcessExplicitAppUserModelID(&mut ptr) < 0 || ptr.is_null() {
                return None;
            }
            let len = (0..).take_while(|&i| *ptr.add(i) != 0).count();
            let id = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
            ffi::CoTaskMemFree(ptr.cast());
            Some(id)
        }
    }

    #[test]
    fn icons_need_a_matching_buffer() {
        let ok = [0u8; 16];
        assert!(set_window_icons_rgba(0, (&[0; 15], 2, 2), (&ok, 2, 2)).is_err());
        assert!(set_window_icons_rgba(0, (&ok, 2, 2), (&[], 0, 0)).is_err());
        assert!(set_window_icons_rgba(0, (&ok, 2, 2), (&ok, 2, 3)).is_err());
        assert!(icon_from_rgba(&[0; 4 * 32 * 32 - 1], 32, 32).is_err());
    }

    #[test]
    fn relaunch_values_are_lpwstr_propvariants() {
        use windows::Win32::System::Variant::VT_LPWSTR;
        for value in ["S3 Explorer", r#""C:\Program Files\S3 Explorer\s3explorer.exe""#, r"C:\x\icons\blue.ico,0", ""] {
            let pv = lpwstr_propvariant(value).expect("propvariant");
            assert_eq!(pv.vt(), VT_LPWSTR);
            // SAFETY: just built as VT_LPWSTR with a NUL-terminated string.
            let back = unsafe { pv.Anonymous.Anonymous.Anonymous.pwszVal.to_string() }.expect("utf-16");
            assert_eq!(back, value);
        }
    }

    /// No window (handle 0): an error, never a panic or a crash.
    #[test]
    fn relaunch_properties_without_a_window_fail_cleanly() {
        assert!(set_relaunch_properties(0, r"C:\x.ico,0", r#""C:\x.exe""#, "S3 Explorer").is_err());
        assert!(set_window_app_id(0, "dev.s3explorer.app.blue").is_err());
        assert_eq!(window_app_id(0), None);
    }

    /// On a real (hidden, never shown) window the four values are stored as VT_LPWSTR and read back
    /// unchanged from a fresh property store of that window.
    #[test]
    fn relaunch_properties_round_trip_on_a_real_window() {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::Storage::EnhancedStorage::{
            PKEY_AppUserModel_ID, PKEY_AppUserModel_RelaunchCommand, PKEY_AppUserModel_RelaunchDisplayNameResource,
            PKEY_AppUserModel_RelaunchIconResource,
        };
        use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
        use windows::Win32::System::Variant::VT_LPWSTR;
        use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, SHGetPropertyStoreForWindow};

        // Own thread: an STA like the app's main thread, without touching other tests' threads.
        std::thread::spawn(|| {
            let class: Vec<u16> = "STATIC".encode_utf16().chain(std::iter::once(0)).collect();
            // SAFETY: COM init on this thread, balanced below; a hidden top-level STATIC window
            // destroyed before the thread ends.
            unsafe {
                assert!(CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok());
                let hwnd = ffi::CreateWindowExW(0, class.as_ptr(), class.as_ptr(), 0, 0, 0, 10, 10, 0, 0, 0, std::ptr::null());
                assert_ne!(hwnd, 0, "CreateWindowExW");
                let (icon, cmd) = (r"C:\x\icons\red.ico,0", r#""C:\Program Files\S3 Explorer\s3explorer.exe""#);
                assert_eq!(window_app_id(hwnd), None, "a new window has no ID");
                set_window_app_id(hwnd, "dev.s3explorer.app.green").expect("first id");
                assert_eq!(window_app_id(hwnd).as_deref(), Some("dev.s3explorer.app.green"));
                // An accent change replaces it; the same ID again is a no-op.
                set_window_app_id(hwnd, "dev.s3explorer.app.blue").expect("second id");
                set_window_app_id(hwnd, "dev.s3explorer.app.blue").expect("same id");
                set_relaunch_properties(hwnd, icon, cmd, "S3 Explorer").expect("set");
                let store: IPropertyStore = SHGetPropertyStoreForWindow(HWND(hwnd as *mut core::ffi::c_void)).expect("store");
                for (key, want) in [
                    (PKEY_AppUserModel_ID, "dev.s3explorer.app.blue"),
                    (PKEY_AppUserModel_RelaunchCommand, cmd),
                    (PKEY_AppUserModel_RelaunchDisplayNameResource, "S3 Explorer"),
                    (PKEY_AppUserModel_RelaunchIconResource, icon),
                ] {
                    let pv = store.GetValue(&key).expect("get");
                    assert_eq!(pv.vt(), VT_LPWSTR, "{want}");
                    assert_eq!(pv.Anonymous.Anonymous.Anonymous.pwszVal.to_string().expect("utf-16"), want);
                }
                drop(store);
                ffi::DestroyWindow(hwnd);
                CoUninitialize();
            }
        })
        .join()
        .expect("window thread");
    }

    #[test]
    fn mask_rows_are_padded_to_sixteen_bits() {
        assert_eq!(mask_len(32, 32), 4 * 32);
        assert_eq!(mask_len(256, 256), 32 * 256);
        assert_eq!(mask_len(1, 1), 2);
        assert_eq!(mask_len(17, 2), 8);
    }

    /// With no window (handle 0) the calls fail harmlessly; the icons are still created, kept and
    /// replaced (the previous pair destroyed) on each call.
    #[test]
    fn a_second_call_replaces_the_icons_it_created() {
        let small = vec![255u8; 32 * 32 * 4];
        let big = vec![128u8; 256 * 256 * 4];
        set_window_icons_rgba(0, (&small, 32, 32), (&big, 256, 256)).expect("first");
        let first = *CREATED.lock().expect("lock");
        assert!(first.0 != 0 && first.1 != 0);
        set_window_icons_rgba(0, (&small, 32, 32), (&big, 256, 256)).expect("second");
        let second = *CREATED.lock().expect("lock");
        assert!(second.0 != 0 && second.1 != 0 && second != first);
    }

    /// The test binary lives in `target\debug\deps`, not `target\debug`, so it counts as an
    /// installed copy and the ID must be set and read back unchanged.
    #[test]
    fn sets_the_process_app_user_model_id_outside_cargo_target() {
        assert!(!running_from_cargo_target());
        set_app_user_model_id("dev.s3explorer.app");
        assert_eq!(current_id().as_deref(), Some("dev.s3explorer.app"));
    }
}
