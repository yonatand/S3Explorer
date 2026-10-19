---
name: smoke-test
description: Integration-test the S3 backend against a local SeaweedFS S3 server (no Docker, no real AWS credentials). Use to validate list/upload/download/folder operations end to end and measure parallel transfer throughput.
---

# Local S3 smoke test (SeaweedFS)

MinIO's download server (dl.min.io) returns 410 Gone since the project was archived, and Docker
is usually not running here. Use the single-binary SeaweedFS server instead. Keep the binary in the
session scratchpad directory, never in the repo; its data goes under `src-tauri/target/` (git-ignored, on D:).

## Start SeaweedFS
```bash
SW="$(cygpath -u "$TMP")/claude/s3explorer-seaweed"; mkdir -p "$SW"
# Data on D:, not C: (see below). Absolute path to the repo's target dir.
SWDATA="/d/Projects/Personal/s3explorer/src-tauri/target/seaweed-data"; mkdir -p "$SWDATA"
if [ ! -f "$SW/weed.exe" ]; then
  curl -sSL -o "$SW/seaweed.zip" https://github.com/seaweedfs/seaweedfs/releases/latest/download/windows_amd64.zip
  (cd "$SW" && unzip -o -q seaweed.zip)
fi
cat > "$SW/s3.json" <<'JSON'
{"identities":[{"name":"admin","credentials":[{"accessKey":"minioadmin","secretKey":"minioadmin"}],"actions":["Admin","Read","Write","List","Tagging"]}]}
JSON
"$SW/weed.exe" server -dir="$SWDATA" -s3 -s3.port=8333 -s3.config="$SW/s3.json" -ip=127.0.0.1 -master.port=9333 -volume.port=8080 -filer.port=8888 -volume.max=100 -master.volumeSizeLimitMB=1024
```
Run the last line with `run_in_background: true`. Keep the data directory on D: (`src-tauri/target/seaweed-data`):
C: is nearly full on this machine and SeaweedFS refuses to allocate volumes when its disk has under 1% free.
The binary can stay in the scratchpad. On macOS/Linux use the `darwin_arm64.tar.gz`
or `linux_amd64.tar.gz` release asset and `chmod +x weed`. Ready when
`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8333/` returns 403 (signed request required).

Connection for the app or tests: static credentials `minioadmin` / `minioadmin`, region
`us-east-1`, endpoint `http://127.0.0.1:8333`, force path style on.

## Run the backend smoke example
```bash
cd src-tauri && cargo run --example smoke 2>&1 | tail -40
```
Env overrides: `SMOKE_ENDPOINT` (default `http://127.0.0.1:8333`), `SMOKE_ACCESS_KEY` /
`SMOKE_SECRET_KEY` (default `minioadmin`), `SMOKE_DIR` (scratch dir), `SMOKE_BIG_MIB` (default 40; at least 15,
or the pause/resume checks fail on purpose: the transfer must still be running when it is paused).
It creates a bucket and folder, uploads a large random file (multipart path) and a tiny one
(PutObject path), lists with paging, heads, downloads (parallel ranged path) and compares
SHA-256, exercises cancel and a missing-key failure, then deletes the folder with >2,000 keys
and confirms it is empty. Record the reported MiB/s for upload and download. Reference on this
machine: 40 MiB upload ~300 MiB/s, download ~450 MiB/s; 512 MiB upload ~480 MiB/s, download ~650 MiB/s.

The smoke example also pauses and resumes a download and an upload (byte-identical after resume) and
pauses then cancels an upload (no multipart upload or object left behind).

## Other harnesses in src-tauri/examples
- `cargo run --example jobs`: delete, copy, move and rename. 110+ checks, each comparing a full snapshot of the
  bucket (every key, size, hash) before and after. Run it after any change under `src-tauri/src/jobs/`.
  `JOBS_TRUNCATION=1` adds a 100,000-object run.
- `cargo run --release --example bench -- gen|put|get ...`: throughput, peak memory, retries and wasted bytes for one
  transfer with given part size and parallelism. Put multi-GiB data under `src-tauri/target/` (D:), never on C:.
  `throttle.mjs` in the scratchpad is a bandwidth-capping proxy for slow-link tests.
- `cargo run --example search`: bucket search (v0.6.0): keyword/phrase/exclusion/tag terms, path narrowing and its
  fallback, exact-path hit, limit truncation, cancellation by `searchId` and `cancel_search`, folder markers skipped.
  Run it after any change to `src-tauri/src/search.rs`.
- `cargo run --example metadata`: editing content type and metadata (copy onto itself, `MetadataDirective=REPLACE`).
  Snapshots the bucket around every scenario: body, storage class, tags and other headers survive; a stale ETag
  (`If-Match` answered 412) or a metadata-only change by another client writes nothing; HTTP-token metadata keys and
  empty values round-trip; GLACIER / DEEP_ARCHIVE objects are refused before any write; invalid input writes nothing. Needs `SMOKE_ENDPOINT`. Run it after any change to
  `src-tauri/src/metadata.rs`.
- `keychain_check`, `saved_e2e`: saved connections against the real OS keychain using the TEST service name
  `dev.s3explorer.app.test`. `updater_check`: the update check and a failing-signature install against a local server.
- Linking can fail with "paging file is too small (os error 1455)" or a spurious `E0463`; rerun with `-j 2`.

## Building on this machine (memory is short)
- Run dev builds (`cargo build`/`test`/`run --example`, `npm run tauri dev`) with
  `CARGO_PROFILE_DEV_DEBUG=1 CARGO_PROFILE_DEV_CODEGEN_UNITS=16 CARGO_BUILD_JOBS=2` in the environment. Without
  them the compiler crashed during v0.9.0 with `STATUS_STACK_BUFFER_OVERRUN`, `E0463` (can't find crate) or
  "invalid metadata" errors when memory ran short. These are not code errors; rerun with the variables set.
- The local-pane trash tests (`local_fs.rs`, `cargo test`) move scratch files into the **real Recycle Bin**
  of the drive they live on (D:, under the target dir). They fail if D:'s recycle bin is disabled, set to
  "remove files immediately", or too small. Empty the bin of those scratch entries afterwards if you care.

## Lessons from v0.5.x
- Assert the painted state of progress bars (the fill's rendered width via getBoundingClientRect), not only
  DOM attributes or store state. The v0.5.0 end-to-end run saw byte counts update beside bars whose fill had
  zero width (an inline element) and reported them fine.
- A stale vite from an earlier run holding port 1420 makes `npm run tauri dev` exit silently right after
  "Running BeforeDevCommand". Kill the port holder first (`netstat -ano | findstr :1420`).

## When a test drives the real app
- It uses the real keychain service and `%APPDATA%dev.s3explorer.app`. Back both up first, prefix test connections
  with `e2e-`, delete them through the app, and prove afterwards (`cmdkey /list`, file hashes) that nothing is left.
- Never click "Install and restart" or call `install_update` against the real repository.

## SeaweedFS limitations to know
- Without `-volume.max=100 -master.volumeSizeLimitMB=1024` it runs out of volume slots and returns InternalError on larger runs.
- It normalizes keys: `a//b.txt` is stored as `a/b.txt`, `..` segments are rejected and backslashes are rewritten. Double-slash and
  path-traversal key scenarios therefore cannot be reproduced end to end here; cover them with unit tests (Rust `ops.rs`,
  TS helpers in `src/lib/format.ts`) or against real S3.
- Empty-folder cleanup is asynchronous, so a just-deleted folder can linger in a listing for a moment.
- A 64 MiB download finishes in ~150 ms locally. To test Cancel from the UI, seed a 1 GiB object.

## Driving the real app
Launch the release exe with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223` and attach over the
Chrome DevTools Protocol (`http://127.0.0.1:9223/json`). Native file dialogs cannot be driven or stubbed over CDP: call
`window.__TAURI_INTERNALS__.invoke('start_upload' | 'start_download', ...)` from the page and assert on the UI.
Never use SendKeys or other OS-level input automation: keystrokes can land in whatever window the user has focused.

## Taskbar icon test (Windows)

The taskbar button's icon cannot be read through an API; look at it. Run the app the way the installed build
runs (with its AppUserModelID: a copy of the exe *outside* `src-tauri/target/`), drive it over WebView2's
debugging port, and screenshot the taskbar DPI-aware.

```bash
npm run dev &                                   # the debug exe loads the UI from :1420
cp src-tauri/target/debug/s3explorer.exe "$SCRATCH/app/"
(cd "$SCRATCH/app" && WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223" cmd //c start "" s3explorer.exe)
# evaluate in the page (node, global WebSocket): fetch http://127.0.0.1:9223/json → webSocketDebuggerUrl → Runtime.evaluate
#   window.__TAURI_INTERNALS__.invoke('set_window_icon', { accent: 'blue' })
```

Screenshot the bottom 64 px of the primary screen with PowerShell after `SetProcessDPIAware()` (without it the
capture is offset on a scaled display): `[System.Windows.Forms.Screen]::PrimaryScreen.Bounds` +
`Graphics.CopyFromScreen`, save PNG, crop and upscale the app-button area, then view the image. Compare before
and after, and a fresh start with the accent saved. `update_settings` changes the user's real settings file:
restore the accent afterwards. v0.9.2 lesson: with an AppUserModelID set, the taskbar takes the button's icon
from the Start-menu shortcut; only a per-accent window ID (`<identifier>.<accent>`) makes it use the window's icon.

## Clean up
Kill the server (`TaskStop`, or `taskkill //F //IM weed.exe`). Leave the binary cached in the
scratchpad so the next run skips the download. Never commit test data.
