//! The file manager override (`AppSettings.fileManagerCommand`): a one-line command run instead of
//! the system file manager for "Show in folder" and "Open folder". See "File manager override
//! (setting)" in `docs/CONTRACT.md`.
//!
//! No shell is ever involved: the line is split here (double quotes group, `\"` is a literal
//! quote), `{path}` and `{dir}` are replaced inside the split arguments (so a path with spaces or
//! quotes stays one argument), and the program is started directly.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::error::{AppError, AppResult, ErrorCode};

/// Splits a command line into a program and its arguments. Whitespace outside double quotes
/// separates; `"` groups (and is dropped); `\"` is a literal quote, inside or outside quotes;
/// every other backslash is literal (Windows paths). `""` is an empty argument.
pub fn split_command(line: &str) -> AppResult<Vec<String>> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut has_token = false;
    let mut in_quote = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' if chars.peek() == Some(&'"') => {
                chars.next();
                cur.push('"');
                has_token = true;
            }
            '"' => {
                in_quote = !in_quote;
                has_token = true;
            }
            c if c.is_whitespace() && !in_quote => {
                if has_token {
                    out.push(std::mem::take(&mut cur));
                    has_token = false;
                }
            }
            c => {
                cur.push(c);
                has_token = true;
            }
        }
    }
    if in_quote {
        return Err(AppError::invalid("The file manager command has a quote that is never closed"));
    }
    if has_token {
        out.push(cur);
    }
    if out.first().is_none_or(|p| p.is_empty()) {
        return Err(AppError::invalid("The file manager command names no program"));
    }
    Ok(out)
}

const PATH_PLACEHOLDER: &str = "{path}";
const DIR_PLACEHOLDER: &str = "{dir}";

/// Replaces `{path}` and `{dir}` in one pass (a path that itself contains `{dir}` is not
/// replaced again).
fn replace_placeholders(arg: &str, path: &str, dir: &str) -> String {
    let mut out = String::with_capacity(arg.len());
    let mut rest = arg;
    loop {
        let next = [(rest.find(PATH_PLACEHOLDER), PATH_PLACEHOLDER, path), (rest.find(DIR_PLACEHOLDER), DIR_PLACEHOLDER, dir)]
            .into_iter()
            .filter_map(|(i, p, v)| i.map(|i| (i, p, v)))
            .min_by_key(|(i, _, _)| *i);
        match next {
            Some((i, p, v)) => {
                out.push_str(&rest[..i]);
                out.push_str(v);
                rest = &rest[i + p.len()..];
            }
            None => {
                out.push_str(rest);
                return out;
            }
        }
    }
}

/// The arguments (after the program) with the placeholders replaced; `{dir}` is appended when
/// no argument names a placeholder. The program itself is never substituted.
pub fn substitute(args: &[String], path: &str, dir: &str) -> Vec<String> {
    let named = args.iter().any(|a| a.contains(PATH_PLACEHOLDER) || a.contains(DIR_PLACEHOLDER));
    let mut out: Vec<String> = args.iter().map(|a| replace_placeholders(a, path, dir)).collect();
    if !named {
        out.push(dir.to_string());
    }
    out
}

/// Shells and script hosts: a file manager is never one of these (file name, any case, with or
/// without `.exe`).
pub const REFUSED_PROGRAMS: [&str; 10] = ["cmd", "powershell", "pwsh", "wscript", "cscript", "mshta", "sh", "bash", "zsh", "fish"];

/// Whether the file name of `exe` is a shell or script host.
pub fn is_shell(exe: &Path) -> bool {
    let Some(name) = exe.file_name().map(|n| n.to_string_lossy().to_lowercase()) else { return false };
    let stem = name.strip_suffix(".exe").unwrap_or(&name);
    REFUSED_PROGRAMS.contains(&stem)
}

/// The program as a file, using this process's `PATH` and `PATHEXT`; see [`find_program_in`].
pub fn find_program(program: &str) -> AppResult<PathBuf> {
    let path = std::env::var_os("PATH");
    let pathext = std::env::var("PATHEXT").ok();
    find_program_in(program, path.as_deref(), pathext.as_deref(), cfg!(windows))
}

/// Resolves `program` without depending on the working directory:
/// - an absolute path must be a file;
/// - a name with a relative directory part (`bin\fm.exe`, `./fm`) is refused;
/// - a bare name is looked up in the absolute `PATH` entries (relative ones are skipped). On
///   Windows a name without an extension tries only the `PATHEXT` extensions, never the
///   extensionless file (as `cmd.exe` does); a name with an extension is tried as is.
///
/// The resolved file must not be a shell or script host ([`REFUSED_PROGRAMS`]).
pub fn find_program_in(
    program: &str,
    path_var: Option<&std::ffi::OsStr>,
    pathext: Option<&str>,
    windows: bool,
) -> AppResult<PathBuf> {
    let not_found = || AppError::invalid(format!("File manager not found: {program}"));
    let p = Path::new(program);
    let found = if p.is_absolute() {
        p.is_file().then(|| p.to_path_buf()).ok_or_else(not_found)?
    } else if p.components().count() > 1 || program.contains(['/', '\\']) {
        return Err(AppError::invalid(format!(
            "The file manager must be an absolute path or a program name on PATH, not a relative path: {program}"
        )));
    } else {
        let candidates: Vec<String> = if windows && p.extension().is_none() {
            pathext
                .unwrap_or(".COM;.EXE;.BAT;.CMD")
                .split(';')
                .map(str::trim)
                .filter(|e| !e.is_empty())
                .map(|e| format!("{program}{e}"))
                .collect()
        } else {
            vec![program.to_string()]
        };
        let dirs = path_var.ok_or_else(not_found)?;
        std::env::split_paths(dirs)
            .filter(|d| d.is_absolute())
            .find_map(|d| candidates.iter().map(|c| d.join(c)).find(|c| c.is_file()))
            .ok_or_else(not_found)?
    };
    if is_shell(&found) {
        let name = found.file_name().map_or_else(|| program.to_string(), |n| n.to_string_lossy().into_owned());
        return Err(AppError::invalid(format!("{name} is a shell, not a file manager")));
    }
    Ok(found)
}

/// `{dir}` for `path`: a folder itself, otherwise the folder that contains it.
pub fn dir_of(path: &Path) -> PathBuf {
    if path.is_dir() {
        path.to_path_buf()
    } else {
        path.parent().filter(|p| !p.as_os_str().is_empty()).map_or_else(|| path.to_path_buf(), Path::to_path_buf)
    }
}

/// Starts the file manager `command` for `path`, detached, without waiting. Blocking (file
/// system); call through `spawn_blocking`.
pub fn launch(command: &str, path: &Path) -> AppResult<()> {
    let parts = split_command(command)?;
    let program = &parts[0];
    let exe = find_program(program)?;
    let path_s = path.to_string_lossy();
    let dir_s = dir_of(path).to_string_lossy().into_owned();
    let args = substitute(&parts[1..], &path_s, &dir_s);
    let mut cmd = Command::new(&exe);
    cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Not tied to this app's console or process group (and no console window for a console program).
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::new(ErrorCode::Io, format!("Could not start {}: {e}", exe.display())))?;
    // Never wait on the caller's thread; reap it in the background so no zombie stays behind.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::ScratchDir;

    fn v(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn splitting() {
        assert_eq!(
            split_command(r#""C:\Program Files\totalcmd\TOTALCMD64.EXE" /O /T "{dir}""#).expect("ok"),
            v(&[r"C:\Program Files\totalcmd\TOTALCMD64.EXE", "/O", "/T", "{dir}"])
        );
        assert_eq!(split_command("nautilus --select \"{path}\"").expect("ok"), v(&["nautilus", "--select", "{path}"]));
        assert_eq!(split_command("  open\t -R   {path} ").expect("ok"), v(&["open", "-R", "{path}"]));
        // Quotes group inside an argument; `\"` is a literal quote; other backslashes stay.
        assert_eq!(split_command(r#"fm --x="a b"c \"q\" C:\dir\"#).expect("ok"), v(&["fm", "--x=a bc", "\"q\"", r"C:\dir\"]));
        assert_eq!(split_command(r#"fm "say \"hi\"" """#).expect("ok"), v(&["fm", "say \"hi\"", ""]));
        // No shell: variables and operators are plain text.
        assert_eq!(split_command("fm %USERPROFILE% $HOME && rm").expect("ok"), v(&["fm", "%USERPROFILE%", "$HOME", "&&", "rm"]));
        for bad in ["", "   ", "\"\" x", "fm \"open"] {
            assert_eq!(split_command(bad).unwrap_err().code, ErrorCode::InvalidInput, "{bad:?}");
        }
    }

    #[test]
    fn substitution_keeps_a_path_one_argument() {
        let path = r#"C:\My Files\a "quoted" {dir} name.txt"#;
        let dir = r"C:\My Files";
        let args = substitute(&v(&["/O", "--select={path}", "{dir}", "x{path}y{dir}"]), path, dir);
        assert_eq!(args.len(), 4);
        assert_eq!(args[1], format!("--select={path}"), "the {{dir}} inside the path is not replaced again");
        assert_eq!(args[2], dir);
        assert_eq!(args[3], format!("x{path}y{dir}"));
    }

    #[test]
    fn dir_is_appended_without_placeholders() {
        assert_eq!(substitute(&v(&["/O", "/T"]), "p", "d"), v(&["/O", "/T", "d"]));
        assert_eq!(substitute(&[], "p", "d"), v(&["d"]));
        assert_eq!(substitute(&v(&["{path}"]), "p", "d"), v(&["p"]));
        assert_eq!(substitute(&v(&["{dir}"]), "p", "d"), v(&["d"]));
    }

    #[test]
    fn dir_of_a_file_and_a_folder() {
        let dir = ScratchDir::new("fm-dir");
        let file = dir.0.join("a.txt");
        std::fs::write(&file, b"x").expect("write");
        assert_eq!(dir_of(&file), dir.0);
        assert_eq!(dir_of(&dir.0), dir.0);
    }

    #[test]
    fn a_missing_program_is_refused() {
        let dir = ScratchDir::new("fm-missing");
        let missing = dir.0.join("no such fm.exe");
        let e = launch(&format!("\"{}\" {{dir}}", missing.display()), &dir.0).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidInput);
        assert!(e.message.starts_with("File manager not found: "), "{}", e.message);
        let e = launch("surely-no-such-file-manager-xyz {path}", &dir.0).unwrap_err();
        assert!(e.message.starts_with("File manager not found: "), "{}", e.message);
        // A directory is not a program.
        let e = launch(&format!("\"{}\"", dir.0.display()), &dir.0).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidInput);
    }

    #[test]
    fn launches_a_real_program_detached() {
        // A program that exists everywhere and exits at once.
        let dir = ScratchDir::new("fm-launch");
        let cmd = if cfg!(windows) { "whoami.exe /?" } else { "true" };
        assert!(find_program(cmd.split(' ').next().expect("program")).is_ok());
        launch(cmd, &dir.0).expect("launch");
    }

    /// A temp folder used as PATH, holding the given (empty) files.
    fn path_dir(files: &[&str]) -> ScratchDir {
        let d = ScratchDir::new("fm-path");
        for f in files {
            std::fs::write(d.0.join(f), b"").expect("write");
        }
        d
    }

    #[test]
    fn windows_bare_names_try_only_pathext() {
        let d = path_dir(&["code", "code.cmd", "plain"]);
        let path = std::env::join_paths([d.0.clone()]).expect("join");
        let found = find_program_in("code", Some(&path), Some(".COM;.EXE;.BAT;.CMD"), true).expect("found");
        let name = found.file_name().map(|n| n.to_string_lossy().to_lowercase());
        assert_eq!((found.parent(), name.as_deref()), (Some(d.0.as_path()), Some("code.cmd")), "never the extensionless file");
        // Only an extensionless file: not found on Windows, found elsewhere.
        assert!(find_program_in("plain", Some(&path), Some(".EXE;.CMD"), true).is_err());
        assert_eq!(find_program_in("plain", Some(&path), None, false).expect("unix"), d.0.join("plain"));
        // A name with an extension is tried as is.
        assert_eq!(find_program_in("code.cmd", Some(&path), Some(".EXE"), true).expect("as is"), d.0.join("code.cmd"));
    }

    #[test]
    fn relative_paths_are_refused_and_relative_path_entries_skipped() {
        let d = path_dir(&["fm.exe"]);
        for bad in [r"bin\fm.exe", "./fm", "bin/fm.exe", r".\fm.exe"] {
            let e = find_program_in(bad, None, None, true).unwrap_err();
            assert_eq!(e.code, ErrorCode::InvalidInput, "{bad}");
            assert!(e.message.contains("not a relative path"), "{bad}: {}", e.message);
        }
        // Relative PATH entries ("", ".", a relative folder) are skipped even when they would match.
        let cwd = std::env::current_dir().expect("cwd");
        let rel = d.0.strip_prefix(&cwd).map(Path::to_path_buf).expect("the scratch dir lies under the working directory");
        assert!(rel.is_relative() && rel.join("fm.exe").is_file());
        let path = std::env::join_paths([PathBuf::from(""), PathBuf::from("."), rel]).expect("join");
        assert!(find_program_in("fm.exe", Some(&path), Some(".EXE"), true).is_err());
        let path = std::env::join_paths([d.0.clone()]).expect("join");
        assert_eq!(find_program_in("fm.exe", Some(&path), Some(".EXE"), true).expect("absolute entry"), d.0.join("fm.exe"));
        // An absolute program path is fine.
        let abs = d.0.join("fm.exe");
        assert_eq!(find_program_in(&abs.to_string_lossy(), None, None, true).expect("abs"), abs);
    }

    #[test]
    fn shells_are_refused() {
        let names = [
            "cmd.exe", "PowerShell.exe", "pwsh", "wscript.exe", "cscript.exe", "mshta.exe", "sh", "bash", "zsh", "fish", "Bash.exe",
        ];
        let d = path_dir(&names);
        let path = std::env::join_paths([d.0.clone()]).expect("join");
        for name in names {
            let e = find_program_in(name, Some(&path), None, false).unwrap_err();
            assert_eq!(e.code, ErrorCode::InvalidInput, "{name}");
            assert!(e.message.ends_with("is a shell, not a file manager"), "{name}: {}", e.message);
        }
        // By the resolved file name: a bare "cmd" found as cmd.exe through PATHEXT, and an absolute path.
        let e = find_program_in("cmd", Some(&path), Some(".EXE"), true).unwrap_err();
        assert!(e.message.contains("is a shell"), "{}", e.message);
        let e = find_program_in(&d.0.join("cmd.exe").to_string_lossy(), None, None, true).unwrap_err();
        assert!(e.message.contains("is a shell"), "{}", e.message);
        assert!(is_shell(Path::new("CMD.EXE")) && is_shell(Path::new("Pwsh.Exe")) && is_shell(Path::new("/bin/ZSH")));
        // Lookalikes are not shells.
        for ok in ["bashful.exe", "cmdr.exe", "fishy", "shx.exe", "totalcmd64.exe", "explorer.exe"] {
            assert!(!is_shell(Path::new(ok)), "{ok}");
        }
    }
}
