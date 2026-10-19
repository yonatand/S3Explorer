//! v0.9.1 "Network locations in a local pane" (Windows only): reads the target of a shell shortcut
//! (`.lnk`), which is how Windows stores the user's saved Network Locations
//! (`%APPDATA%\Microsoft\Windows\Network Shortcuts\<name>\target.lnk`).
//!
//! The shortcut is only read (`IPersistFile::Load` + `IShellLinkW::GetPath`); it is never
//! `Resolve`d, so nothing here searches for a moved target or touches the network on purpose. The
//! caller still bounds the whole enumeration in time (`local_fs::network_roots`).

use std::path::Path;

use windows::core::{Interface, PCWSTR};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, STGM_READ,
};
use windows::Win32::UI::Shell::{IShellLinkW, SHGetPathFromIDListEx, ShellLink, GPFIDL_DEFAULT, SLGP_UNCPRIORITY};

/// Longest target path read (UNC paths may exceed `MAX_PATH`).
const PATH_MAX: usize = 4096;

/// COM initialized (apartment-threaded) on this thread for as long as it lives. Create it on a
/// thread of the caller's own, never a shared pool thread.
pub struct ComApartment {
    initialized: bool,
}

impl ComApartment {
    pub fn init() -> Self {
        // SAFETY: no pointers. S_OK and S_FALSE (already initialized here) both need a matching
        // CoUninitialize; a failure (another threading model) needs none and COM still works.
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
        Self { initialized: hr.is_ok() }
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.initialized {
            // SAFETY: balanced with the successful CoInitializeEx in `init`, on the same thread.
            unsafe { CoUninitialize() };
        }
    }
}

fn wide(p: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    p.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

fn until_nul(buf: &[u16]) -> String {
    let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..n])
}

/// The file-system path a shortcut points at (UNC preferred over a mapped drive letter). `Err`
/// when the file is not a readable shortcut or its target has no file-system path (an FTP or web
/// location). Needs a [`ComApartment`] on this thread.
pub fn target(lnk: &Path) -> Result<String, String> {
    let name = wide(lnk);
    // SAFETY: COM calls on interfaces created here; every buffer is as long as the length passed
    // (the `windows` wrappers take slices), and the ID list is freed with CoTaskMemFree.
    unsafe {
        let link: IShellLinkW =
            CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(|e| format!("ShellLink: {e}"))?;
        let file: IPersistFile = link.cast().map_err(|e| format!("IPersistFile: {e}"))?;
        file.Load(PCWSTR(name.as_ptr()), STGM_READ).map_err(|e| format!("Could not read the shortcut: {e}"))?;
        let mut buf = vec![0u16; PATH_MAX];
        // S_FALSE (no path) leaves the buffer empty.
        if link.GetPath(&mut buf, std::ptr::null_mut(), SLGP_UNCPRIORITY.0 as u32).is_ok() {
            let path = until_nul(&buf);
            if !path.is_empty() {
                return Ok(path);
            }
        }
        // A network folder saved as an ID list only: ask the shell for its path.
        let pidl = link.GetIDList().map_err(|e| format!("The shortcut has no target: {e}"))?;
        if pidl.is_null() {
            return Err("The shortcut has no target".into());
        }
        buf.fill(0);
        let ok = SHGetPathFromIDListEx(pidl, &mut buf, GPFIDL_DEFAULT).as_bool();
        CoTaskMemFree(Some(pidl as *const core::ffi::c_void));
        let path = until_nul(&buf);
        if ok && !path.is_empty() {
            Ok(path)
        } else {
            Err("The shortcut's target is not a file system location".into())
        }
    }
}

/// Test helper: writes a shortcut at `lnk` pointing at `target_path`.
#[cfg(test)]
pub fn create(lnk: &Path, target_path: &str) -> Result<(), String> {
    let name = wide(lnk);
    let target_w: Vec<u16> = target_path.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: COM calls on interfaces created here with NUL-terminated strings that outlive them.
    unsafe {
        let link: IShellLinkW =
            CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(|e| format!("ShellLink: {e}"))?;
        link.SetPath(PCWSTR(target_w.as_ptr())).map_err(|e| format!("SetPath: {e}"))?;
        let file: IPersistFile = link.cast().map_err(|e| format!("IPersistFile: {e}"))?;
        file.Save(PCWSTR(name.as_ptr()), true).map_err(|e| format!("Save: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::ScratchDir;

    #[test]
    fn reads_the_target_of_a_shortcut() {
        let _com = ComApartment::init();
        let d = ScratchDir::new("shell-link");
        let target_dir = d.0.join("the target");
        std::fs::create_dir(&target_dir).expect("mkdir");
        let lnk = d.0.join("target.lnk");
        if let Err(e) = create(&lnk, &target_dir.to_string_lossy()) {
            println!("skipping: could not create a shortcut through COM here ({e})");
            return;
        }
        assert_eq!(target(&lnk).expect("target"), target_dir.to_string_lossy());
        // Not a shortcut, and no file at all.
        std::fs::write(d.0.join("fake.lnk"), b"not a shortcut").expect("write");
        assert!(target(&d.0.join("fake.lnk")).is_err());
        assert!(target(&d.0.join("missing.lnk")).is_err());
    }
}
