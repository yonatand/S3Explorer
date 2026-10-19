<p align="center"><img src="src-tauri/icons/128x128@2x.png" width="110" alt="S3 Explorer"></p>

<h1 align="center">S3 Explorer</h1>

<p align="center"><strong>Your buckets, on your desktop.</strong></p>

<p align="center">
  <a href="../../releases/latest"><img src="https://img.shields.io/github/v/release/yonatand/S3Explorer?label=latest&color=ffb81f&style=for-the-badge" alt="Latest version"></a>
  <img src="https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-18181b?style=for-the-badge" alt="Windows, macOS and Linux">
</p>

<h3 align="center">A fast desktop file manager for Amazon S3 and S3-compatible storage, with two panes in the Total Commander style (one of them can be your own computer), whole-folder transfers, object versions, archive restores, and a proper editor for lifecycle rules and tags.<br>One small native executable, no Electron, no subscription.</h3>

<p align="center"><a href="../../releases/latest"><strong>Download the latest release</strong></a></p>

<p align="center">
  <img src="docs/screenshots/banner.svg" alt="Files moving between a computer and an S3 bucket in parallel parts" width="100%">
</p>

<p align="center">
  <img src="docs/screenshots/showcase.png" alt="S3 Explorer: the start screen with saved connections and a bucket open" width="100%">
</p>

## Why this exists

I didn't want to pay for an S3 explorer tool. So I vibe coded one. :)

**This project is vibe coded.** I described what I wanted and AI agents wrote essentially all of it: the Rust backend, the React UI, the tests, the build pipeline, and yes, most of this README. I steered, reviewed the results and said "also add that". If that makes you nervous about pointing it at a production bucket, good. Read [Should you trust it?](#should-you-trust-it) before you do.

## What it does

- **Connect** with an AWS profile from `~/.aws` (including profiles signed in with `aws sso login` or the newer `aws login`), or with access keys. A custom endpoint makes it work with MinIO, Cloudflare R2, SeaweedFS, LocalStack and friends.
- **List buckets**, including buckets in other regions. A bucket shared with you from another account can be added by name, `s3://` address or ARN (the "+" above the bucket list) and used like any other.
- **Browse folders and objects** in a virtualized table that stays smooth with thousands of rows. Size, last modified, storage class, ETag, content type and user metadata are all there.
- **Look inside a file without downloading it.** Selecting a text file or an image shows a preview in the details panel: JSON pretty-printed, CSV and TSV as a table, images fitted to the panel. `F3` (Quick look) opens a big view you can flip through with the arrow keys. Only the start of a large text file is read, and a setting turns automatic previews off.
- **Folder sizes on demand.** Calculate how many objects and bytes a folder (or several) holds. S3 keeps no folder totals, so this is a cancellable scan that stops at 200,000 keys and says "at least" when it does.
- **Search a bucket.** Press `Ctrl+F` (or `/`, or `Alt+F7`), start typing in the search row under the toolbar, and results appear as you type: words, `"a phrase"`, `-not`, `tag:key=value` and a `folder/part` path all combine, over the current folder or the whole bucket. Folders and objects both show up, you can paste a full path or an `s3://` address to jump straight to it, and the results can be downloaded, deleted, tagged or moved like any other rows. S3 has no search of its own, so this is a bounded scan that tells you when it stopped early.
- **Two panes.** Split the window into two explorer panes, each on its own folder or bucket, and copy or move between them by dragging rows across, with `F5` / `F6` (or `Ctrl+Shift+C` / `Ctrl+Shift+X`), or from the right-click menu. Same previews and confirmations as everywhere else. `Ctrl+Shift+Right` / `Ctrl+Shift+Left` make the other pane show the same place as this one.
- **Your computer in a pane.** `Alt+F1` / `Alt+F2` (or "This computer" in the sidebar) turn either pane into a view of a drive or folder on your machine. Copy from a bucket into it to download, from it into a bucket to upload; Move then removes only the originals that finished transferring. New folder, rename, folder sizes and delete work there too, and a local delete always goes to the recycle bin. Network locations work as well: pick a saved Network Location or a mapped drive, or type a `\\server\share` path; the app never deletes anything on a share (shares have no recycle bin), so a move from a share to a bucket uploads and leaves the files where they are.
- **Edit the path.** `Ctrl+L` turns the path bar into a text field: paste an `s3://` address or a local path and press Enter.
- **Tabs** in each pane. Middle-click a folder or press `Ctrl+T` or `Ctrl+N` for a new tab, `Ctrl+W` to close one, `Ctrl+Tab` to switch and `Ctrl+Shift+T` to bring back the last one you closed. Each tab keeps its own selection, filter, search results and history, and when you had more than one tab open they come back the next time you connect to the same account.
- **Bookmarks bar.** Star a folder in the path bar (or press `Ctrl+Shift+D`) and it becomes a chip under the toolbar, one click away. Bookmarks are kept per connection and can be renamed and reordered.
- **Keyboard for everything,** with the Total Commander layout by default: `F5` copy, `F6` move, `Shift+F6` rename, `F7` new folder, `F8` delete, `F2` refresh. If you used an earlier version your own keys are kept, and Reset all in Settings → Keyboard switches to the Total Commander layout. `F1` shows the layout that currently applies, typing a name in a file list jumps to the first row that starts with it, the bucket list and file list are fully keyboard-navigable, `Alt+Left` / `Alt+Right` and the mouse's back and forward buttons walk each pane's history, and Settings → Keyboard lets you rebind any of it and export or import your bindings as a file.
- **Download in parallel parts.** Large objects are split into byte ranges and fetched over several connections at once.
- **Upload** with multipart for large files, by button or by dragging files onto the window.
- **Whole folders in and out.** Upload a folder (or drop one from your desktop) and download folders into a directory. You see how many files, how much data and what already exists before anything moves; existing files are skipped unless you choose Overwrite; file names are made safe for your disk and a transfer never writes outside the folder you chose.
- **Delete, rename, copy and move** objects and folders, within a bucket or between buckets, from the right-click menu, the toolbar, the keyboard (`Delete` or `F8`, `Shift+F6`, `Ctrl+C`, `Ctrl+X`, `Ctrl+V`) or by **dragging** them onto a folder, the path bar or a bucket (hold Ctrl to copy). Every delete, move or overwrite shows you the exact keys and how much is affected before it happens, unless you turn the copy/move confirmation off for the cases where nothing is in the way.
- **Create folders** (`F7`).
- **Versions.** On a versioned bucket, see every version of an object, download one, restore one as the current version, remove a delete marker to bring an object back, or permanently delete a version behind its own confirmation.
- **Restore archived objects** from Glacier and Deep Archive, one at a time or many as a background job, with the retrieval tier and how long the restored copy stays. Archived objects show their restore state, and actions that need the data are disabled until it is back.
- **Tags** on objects and buckets: view, edit, and change them on many objects at once.
- **Edit content type and metadata** of an object: content type, Cache-Control, Content-Disposition and user metadata, with every change shown before → after before it is written.
- **Lifecycle rules** with the full S3 model: filters by prefix, tags and size; moves to colder storage; expiration; noncurrent-version actions; cleanup of incomplete uploads. Every rule is summarised in plain language and every rule that deletes data is marked before you save.
- **Activity panel** for transfers and file operations: live speed, parts, time remaining, pause, resume and cancel, a list of anything that failed. Right-click any row to open the downloaded file or folder, show it in your file manager, jump to the object in the bucket, or copy its key, local path or failures.
- **History** of finished transfers and file operations, kept across restarts (`Ctrl+H`): filter it, see what failed, open a downloaded file again, or download or upload something again on the same connection.
- **Saved connections.** Keep an AWS profile or access keys under a name and connect with one click. Secret keys live in your operating system's keychain, never in a file.
- **Newest files** of the open bucket in the sidebar, wherever they are, filtered by age, type or search.
- **Desktop notifications** when a transfer or operation finishes while the app is in the background.
- **Settings** for part size, parallel parts per transfer and simultaneous transfers, with a live estimate of connections and memory before you save, and optional download and upload speed limits shared by every transfer. "Show in folder" can open a file manager of your choice instead of the system one.
- **Light, dark or system theme**, four accent colours (the window and taskbar icon follow the accent too), and size and text-weight sliders.
- **Open it from the command line** at a local folder or a bucket path; a second launch hands the location to the window that is already open. See [From the command line](#from-the-command-line).
- **Updates from inside the app.** When a new version is out, a window at startup shows its patch notes with Install and Later; after updating, the first launch shows what's new. Only updates signed by this project are installed, and nothing is installed until you click Install.

<p align="center">
  <img src="docs/screenshots/explorer.png" alt="A bucket open, with a file selected and its details showing" width="100%">
</p>

<p align="center">
  <img src="docs/screenshots/transfers.png" alt="The Activity panel: three large downloads in parallel parts and an upload, with speed, parts done and time remaining" width="100%">
</p>

<p align="center">
  <img src="docs/screenshots/safety.png" alt="Before a move or a delete: the exact keys, the totals, and nothing overwritten unless you choose it" width="100%">
</p>

<p align="center">
  <img src="docs/screenshots/folders.png" alt="Uploading a folder: the preview, the destination, and what already exists" width="100%">
</p>

<p align="center">
  <img src="docs/screenshots/lifecycle.png" alt="Lifecycle rules, each summarised in plain language, with the ones that delete data marked" width="100%">
</p>

| | |
|---|---|
| ![Saving lifecycle rules: what changed, and every rule that deletes data in red](docs/screenshots/lifecycle-confirm.png) | ![Editing an object's tags](docs/screenshots/tags.png) |
| ![Every version of an object, with a delete marker](docs/screenshots/versions.png) | ![Restoring an archived object](docs/screenshots/restore.png) |

<p align="center">
  <img src="docs/screenshots/newest-files.png" alt="Newest files in the sidebar: what changed in the bucket last, filtered by age, type or a search" width="100%">
</p>

<p align="center">
  <img src="docs/screenshots/accents.png" alt="The accent colour: yellow, green, blue or red" width="100%">
</p>

### What it does not do (yet)

Creating or deleting buckets, presigned URLs, permissions and ACLs, sync ("sync the other pane" only navigates, it never copies anything), turning versioning on or off, object lock, copying or moving between two folders on your own computer (your file manager does that), and dragging objects out of the app to the desktop (copy them into a local pane instead). It is scoped small on purpose.

## How move, rename, delete, lifecycle and folder transfers stay safe

S3 has no move or rename. The app copies, then deletes the original, and it is careful about the order:

- An original is deleted only after its own copy is confirmed, and not if the original changed in the meantime.
- A delete is counted only when the server confirms it.
- A cancelled or failed move leaves every object in exactly one place.
- A request that would write into its own source, such as moving a folder into itself, is refused.
- Nothing is overwritten unless you choose Overwrite. The default is to skip what already exists.
- Keys are never altered. Spaces, unicode and unusual characters are sent exactly as they are.
- What the confirmation shows is exactly what is sent, and items hidden by the filter are never included. A drag moves exactly the rows you pressed, and only onto the folder that was highlighted.

Lifecycle rules are more dangerous than a delete, because S3 applies them on its own every day. So:

- The editor loads the whole configuration, and refuses to save over one that changed since you loaded it.
- Before saving you see what was added, removed and changed, and every rule that deletes data in red, including rules with a past date, which delete every matching object at the next run.
- A configuration that uses something this version doesn't understand is shown read-only rather than rewritten with a piece missing.
- Tags set by AWS itself are kept, never edited or dropped.

Folder transfers and versions got the same treatment:

- A folder download writes only inside the directory you chose: every path segment is sanitized, two keys that would land on the same file fail the second one, and a path that crosses a symlink or junction is refused.
- Nothing existing is replaced unless you chose Overwrite, and an Overwrite choice older than a minute is re-checked before it starts.
- Permanently deleting a version always sends the exact version shown and refuses an empty id, so it can never turn into a delete of the current object.
- Restoring a version copies that version onto the key; it never deletes anything.
- Disconnecting while work runs asks whether to cancel it, and cancelling waits for every transfer to finish cleanly. Quitting the app cancels everything still running or paused the same way, so no half-finished upload is left in the bucket.

And the newer features:

- Editing an object's content type or metadata copies the object onto itself only if it is still the version you saw (its ETag and last-modified time), keeps its tags, storage class and encryption, and reads it back afterwards to check every field. Objects in Glacier or Deep Archive are refused, because the copy would archive them again.
- A preview reads at most 256 KiB of text (or a 10 MiB image), pinned to the object's ETag, so it never pulls a whole large file and never mixes two versions.
- Folder sizes and searches are bounded scans you can cancel; a size is labelled "at least" when the scan stopped early, and it is cleared when this app changes anything inside the folder.
- A paused transfer resumes only if the object (or the local file, for an upload) is unchanged; otherwise it fails rather than stitching old and new data together.
- History never re-runs anything by itself: "Download again" or "Go to object" goes through the usual dialogs, and only on the connection the entry was recorded on.
- The hidden games on the start screen never touch your buckets or files.

Your own disk, in a local pane:

- Deleting a local file or folder always sends it to the recycle bin (or the trash), never a permanent delete. A drive whose recycle bin is turned off, too small, or not a local disk is refused, and the file stays where it is.
- A move from a bucket to your computer deletes from the bucket only the objects whose download completed, and only if each is still exactly the version that was downloaded; an object changed in the meantime is left in place and reported. A folder move deletes the downloaded keys one by one, never the folder as a whole, so anything added to it since is kept. A move from your computer to a bucket sends to the recycle bin only the files whose upload completed.
- A local pane never follows links or junctions: they are shown with a badge, a move refuses them as sources, and a delete removes the link, not what it points to. Listings and folder sizes are bounded, and network and device paths typed by hand are refused.

## How downloads are split

With the default settings:

| Object size | Part size | How it downloads |
|---|---|---|
| 8 MiB or less | not split | one ordinary GET |
| over 8 MiB, up to 1 GiB | 8 MiB | parallel ranged GETs |
| over 1 GiB | 16 MiB | parallel ranged GETs |

Up to 8 parts of a file are in flight at once, and up to 4 transfers run at the same time while the rest wait in a queue. Each part is written straight to its offset in a pre-sized temp file, which is renamed when the last part lands. Every request carries the object's ETag, so a file that changes mid-download fails instead of being stitched together from two versions. A part that fails resumes from where it stopped.

All three numbers are yours to change in Settings (the gear button): part size from 1 to 256 MiB, 1 to 32 parallel parts, and 1 to 10 simultaneous transfers. An object no larger than one part is fetched in a single request. Uploads always use parts of at least 5 MiB because S3 requires it. Parts larger than 16 MiB are streamed straight to disk, so a bigger part size does not cost more memory; more parallel parts do, and the dialog tells you roughly how much.

## Get it

**Download a build.** Every version is built for Windows, macOS (Apple Silicon and Intel) and Linux by GitHub Actions. Grab the file for your system from the [Releases page](../../releases): either the bare executable or an installer. Each release comes with patch notes. From v0.3.0 on, the app can also update itself, and from v0.8.0 it tells you at startup when a new version is out.

**Or build it yourself.** You need [Node.js](https://nodejs.org) 22+, [Rust](https://rustup.rs) (the exact toolchain is pinned in `src-tauri/rust-toolchain.toml` and installs itself), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
git clone https://github.com/yonatand/S3Explorer.git
cd S3Explorer
npm install
npm run tauri build
```

The executable lands in `src-tauri/target/release/`, with installers under `src-tauri/target/release/bundle/`.

### From the command line

```text
s3explorer [--connection <name>] [<path or s3://bucket/prefix>]
s3explorer --help
```

Opens the app at a local folder (or a file, selected in its folder) or at a bucket and folder, connecting with the saved connection you name, or the one you used last. Relative paths are taken from the shell's current directory. Only one copy of the app runs at a time: launching it again while it is open hands the location to the existing window and brings it to the front.

## IAM permissions

S3 Explorer only does what your credentials allow. It needs no permissions outside S3, never creates or changes IAM resources, and makes no calls to other AWS services. Grant only the rows you want to use:

| To do this | The app calls | You need |
|---|---|---|
| See the list of buckets | `ListBuckets` | `s3:ListAllMyBuckets` on `*` |
| Open a bucket, browse folders, calculate folder sizes | `HeadBucket` (to find the bucket's region), `ListObjectsV2` | `s3:ListBucket` on the bucket |
| See object details, preview, download | `HeadObject`, `GetObject` (a preview is a ranged `GetObject`) | `s3:GetObject` on the objects |
| Search a bucket | `ListObjectsV2`; `HeadObject` for a pasted path; `GetObjectTagging` for `tag:` terms | `s3:ListBucket` on the bucket; `s3:GetObject` and `s3:GetObjectTagging` on the objects for those two cases |
| Upload, create a folder | `PutObject`, `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `AbortMultipartUpload` | `s3:PutObject` and `s3:AbortMultipartUpload` on the objects |
| Delete objects and folders | `ListObjectsV2`, `DeleteObjects` | `s3:ListBucket` on the bucket, `s3:DeleteObject` on the objects |
| Copy | `ListObjectsV2`, `HeadObject`, `CopyObject`; for objects over 5 GiB `CreateMultipartUpload`, `UploadPartCopy`, `CompleteMultipartUpload`, `GetObjectTagging` | `s3:ListBucket` and `s3:GetObject` on the source; `s3:ListBucket`, `s3:GetObject` and `s3:PutObject` on the destination (the app checks what already exists there and confirms each copy before a move deletes anything) |
| Move and rename | Copy, then delete the original | Everything for Copy, plus `s3:DeleteObject` on the source |
| Add a shared bucket | `HeadBucket`, `ListObjectsV2` | `s3:ListBucket` on that bucket |
| View and edit object tags | `GetObjectTagging`, `PutObjectTagging`, `DeleteObjectTagging` | `s3:GetObjectTagging`, `s3:PutObjectTagging`, `s3:DeleteObjectTagging` on the objects |
| View and edit bucket tags | `GetBucketTagging`, `PutBucketTagging`, `DeleteBucketTagging` | `s3:GetBucketTagging`, `s3:PutBucketTagging` on the bucket |
| View and edit lifecycle rules | `GetBucketLifecycleConfiguration`, `PutBucketLifecycleConfiguration`, `DeleteBucketLifecycle`, `GetBucketVersioning` | `s3:GetLifecycleConfiguration`, `s3:PutLifecycleConfiguration`, `s3:GetBucketVersioning` on the bucket |
| Upload or download a folder | The same calls as single uploads and downloads, plus `ListObjectsV2` to check what exists | Nothing beyond the rows above |
| Pause, resume, limit speed, history, bookmarks, tabs | The same calls as the transfers and browsing they apply to | Nothing beyond the rows above |
| Copy or move between a bucket and your computer (a local pane) | The download or upload calls above; a move from a bucket then deletes the downloaded objects with `DeleteObject(s)`, conditional on the ETag that was downloaded | Nothing beyond the download, upload and Delete rows (a move from a bucket needs `s3:DeleteObject`); browsing your own disk calls nothing in S3 |
| See and download versions | `ListObjectVersions`, `HeadObject` and `GetObject` with a version id | `s3:ListBucketVersions` on the bucket, `s3:GetObjectVersion` on the objects |
| Restore a version as current | `CopyObject` (or multipart copy) from a version | `s3:GetObjectVersion` and `s3:PutObject` on the objects (plus the tagging permissions to carry tags) |
| Permanently delete a version | `DeleteObject` with a version id | `s3:DeleteObjectVersion` on the objects |
| Restore archived objects | `HeadObject`, `RestoreObject` | `s3:RestoreObject` on the objects |
| Edit content type and metadata | `HeadObject`, then `CopyObject` of the object onto itself (keeping its tags), then `HeadObject` to verify | `s3:GetObject`, `s3:PutObject`, `s3:GetObjectTagging` and `s3:PutObjectTagging` on the objects (plus the KMS key permissions below for SSE-KMS objects) |

Two things that surprise people:

- **Without `s3:ListAllMyBuckets` the app still works.** It can't show the bucket list, so it asks you to type the bucket name instead.
- **Bucket-level and object-level permissions use different resources.** `s3:ListBucket` goes on `arn:aws:s3:::my-bucket`, while the object actions go on `arn:aws:s3:::my-bucket/*`. Mixing them up is the most common reason for "Access Denied".

### Full access to one bucket

Replace `my-bucket` with your bucket name. Add more buckets by adding their ARNs to both `Resource` lists.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SeeBucketList",
      "Effect": "Allow",
      "Action": "s3:ListAllMyBuckets",
      "Resource": "*"
    },
    {
      "Sid": "BrowseAndManageBucket",
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:GetBucketTagging",
        "s3:PutBucketTagging",
        "s3:GetLifecycleConfiguration",
        "s3:PutLifecycleConfiguration",
        "s3:GetBucketVersioning",
        "s3:ListBucketVersions"
      ],
      "Resource": "arn:aws:s3:::my-bucket"
    },
    {
      "Sid": "ReadWriteDeleteObjects",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload",
        "s3:GetObjectTagging",
        "s3:PutObjectTagging",
        "s3:DeleteObjectTagging",
        "s3:GetObjectVersion",
        "s3:DeleteObjectVersion",
        "s3:RestoreObject"
      ],
      "Resource": "arn:aws:s3:::my-bucket/*"
    }
  ]
}
```

### Read-only

Browse, search and download, nothing else (searching by tag also needs `s3:GetObjectTagging`). Upload, new folder, delete, rename, copy, move, tag and metadata editing and lifecycle rules will fail with "Access Denied", which is the point.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:ListAllMyBuckets",
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::my-bucket"
    },
    {
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::my-bucket/*"
    }
  ]
}
```

### Depending on your setup

- **Tagged objects.** Copying, and editing an object's content type or metadata (which copies the object onto itself), keep an object's tags, which needs `s3:GetObjectTagging` on the source and `s3:PutObjectTagging` on the destination. The tagging permissions are in the full policy above; drop them if you never use tags.
- **Shared buckets.** The owner of a bucket in another account grants you access with a bucket policy on their side; you need nothing in your own account beyond the rows above. Lifecycle rules and bucket tags on someone else's bucket are usually not granted, and the app says so.
- **Lifecycle rules** are a bucket-level setting with real consequences. Give `s3:PutLifecycleConfiguration` only to people who should be able to schedule deletion of the bucket's contents.
- **Versioned buckets.** Seeing and restoring versions needs `s3:ListBucketVersions` and `s3:GetObjectVersion`. `s3:DeleteObjectVersion` is the one permission in this app that allows an unrecoverable action; leave it out if you only want versions to be a safety net.
- **Archived objects.** Restoring needs `s3:RestoreObject`, and AWS bills each restore.
- **KMS-encrypted buckets (SSE-KMS).** Downloads need `kms:Decrypt` and uploads, copies and metadata edits need `kms:GenerateDataKey` (metadata edits also `kms:Decrypt`) on the bucket's KMS key. S3 calls KMS on your behalf; the app itself does not.
- **Other S3-compatible storage** (MinIO, Cloudflare R2, SeaweedFS and others) has its own permission model. The table of calls above tells you what the app will ask the server to do.

The app remembers no more than it must: saved connections keep the secret key in your operating system's keychain, and an AWS profile is read from `~/.aws` each time you connect.

## Should you trust it?

Honest status, as of `v0.9.1`:

| | |
|---|---|
| Tested end to end on Windows against a local S3 server, including every delete, rename, copy and move path | yes |
| Destructive operations tested by comparing a full snapshot of the bucket before and after | yes |
| Unit tests, lint, and integration tests with checksum verification | yes |
| Independent AI code review of the delete, move and download code, with every finding fixed | yes |
| Builds and packages in CI for Windows, macOS and Linux | yes |
| Used against real AWS S3 by the author (browsing, transfers, and the v0.3.0 features) | yes |
| Shared buckets, tags, lifecycle rules, folder transfers, versions, search and the two-pane view tested against real AWS S3 | **not yet** |
| Connecting with a profile signed in through `aws login` tested against a real session | **not yet** |
| The v0.8.0 features (tabs, bookmarks, folder sizes, preview, metadata editing, history, speed limits, pause and resume, the update popup) tested against the mock backend and the local S3 server | yes |
| The same v0.8.0 features tested against real AWS S3 | **not yet** |
| The v0.9.0 features (Total Commander keys and keeping existing keys, the local computer in a pane, edit path, sync the other pane, the command line, the window icon, type to jump) tested against the mock backend and the local S3 server | yes |
| Network locations (v0.9.1) tested against a real share | **the owner's own share only** |
| The same v0.9.0 features tested against real AWS S3 | **not yet** |
| The local-pane and recycle-bin code on macOS and Linux | **compiled in CI only, never run** |
| Restoring from Glacier tested against a server that supports it (the local test server does not) | **unit tests only** |
| Lifecycle storage-class transitions tested against any server (the local test server refuses them) | **unit tests only** |
| In-app update installed for real on any platform | **not yet** |
| macOS and Linux builds actually run by a human | **not yet** |
| Reviewed line by line by a human | **no** |

Some things were done carefully because this tool can delete data and write to your disk:

- Your secret key is never written to a file by the app. A saved connection keeps it in the operating system's keychain; everything else remembers only the name, region, endpoint and access key id.
- Deletes and moves send exactly the keys shown in the confirmation dialog, byte for byte. See [How move, rename, delete, lifecycle and folder transfers stay safe](#how-move-rename-delete-lifecycle-and-folder-transfers-stay-safe).
- Updates are installed only if they carry this project's signature.
- Lifecycle configurations are never saved over one that changed since you loaded it, and every data-deleting rule is called out before you save.
- File names coming from S3 are sanitized before they become local paths, so a hostile key can't write outside the folder you picked.
- The webview runs under a restrictive content security policy and all S3 traffic goes through the Rust side.
- "Open file" opens only a file this app finished downloading or one you browsed to in a local pane, never a program, and a file manager you configure is started directly with the path as one argument, never through a shell.

Still: it is young, AI-written software. Try it on a bucket you can afford to lose before trusting it with one you can't, and prefer credentials that only have the permissions you need.

## How it's built

- **[Tauri v2](https://tauri.app)** shell: the UI runs in the operating system's own webview, which is why the Windows executable is about 20 MB (the hidden 3D game accounts for some of that; its code is loaded only when it starts).
- **Rust** backend using the official AWS SDK and tokio. Transfers run entirely on this side.
- **React + TypeScript + Vite** frontend with a virtualized table.

The two halves talk through a small set of commands and a few progress events, all written down in [docs/CONTRACT.md](docs/CONTRACT.md).

### Developing

```bash
npm run dev          # UI only, in a browser, against a built-in mock (no Rust build needed)
npm run tauri dev    # the real desktop app with hot reload
```

```bash
cd src-tauri
cargo clippy --all-targets
cargo test
cargo run --example smoke   # transfers, end to end against a local S3-compatible server
cargo run --example jobs    # delete, copy and move, with before/after snapshots of the bucket
cargo run --example tags    # tags and bulk tag jobs
cargo run --example lifecycle  # lifecycle rules: round trips, conflicts, server refusals
cargo run --example batches    # folder transfers: round trips, skip/overwrite, collisions, cancel
cargo run --example versions   # versions and restores against a versioned bucket
cargo run --example search     # bucket search: terms, tags, paths, folders, caps, cancellation
cargo run --example metadata   # content type and metadata edits: conditional copies, refusals, snapshots
```

`npm run build` type-checks and bundles the frontend.

### How the vibe coding actually worked

One AI session acted as orchestrator. It picked the stack, wrote the contract between backend and frontend, then handed the two halves to separate agents that built them in parallel. A third agent drove the real executable end to end against a local S3 server, and a fourth did a read-only code review whose findings were fixed before the first tag. Every version since has gone the same way: contract first, halves in parallel, review, end-to-end run, then release.

The rules and playbooks the agents follow are checked in under [.claude/](.claude/), if you're curious what steering an AI-built project looks like in practice. The redesign in v0.4.0 came from a friend's pull request built the same way, and v0.8.0 merged ten more pull requests from the same friend (tabs, bookmarks, folder sizes, previews, metadata editing, history, speed limits, pause and resume, the update popup and a game), each built the same way, then reviewed and fixed before release.

## Versioning

Releases are tagged `vMAJOR.MINOR.PATCH`. Pushing a tag builds the executables for all three platforms and publishes a release with the patch notes from [CHANGELOG.md](CHANGELOG.md).
