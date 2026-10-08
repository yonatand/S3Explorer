<p align="center"><img src="src-tauri/icons/128x128@2x.png" width="110" alt="S3 Explorer"></p>

<h1 align="center">S3 Explorer</h1>

<p align="center"><strong>Your buckets, on your desktop.</strong></p>

<p align="center">
  <a href="../../releases/latest"><img src="https://img.shields.io/github/v/release/yonatand/S3Explorer?label=latest&color=ffb81f&style=for-the-badge" alt="Latest version"></a>
  <img src="https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-18181b?style=for-the-badge" alt="Windows, macOS and Linux">
</p>

<h3 align="center">A fast desktop file manager for Amazon S3 and S3-compatible storage, with whole-folder transfers, object versions, archive restores, and a proper editor for lifecycle rules and tags.<br>One small native executable, no Electron, no subscription.</h3>

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

- **Connect** with an AWS profile from `~/.aws`, or with access keys. A custom endpoint makes it work with MinIO, Cloudflare R2, SeaweedFS, LocalStack and friends.
- **List buckets**, including buckets in other regions. A bucket shared with you from another account can be added by name, `s3://` address or ARN (the "+" above the bucket list) and used like any other.
- **Browse folders and objects** in a virtualized table that stays smooth with thousands of rows. Size, last modified, storage class, ETag, content type and user metadata are all there.
- **Download in parallel parts.** Large objects are split into byte ranges and fetched over several connections at once.
- **Upload** with multipart for large files, by button or by dragging files onto the window.
- **Whole folders in and out.** Upload a folder (or drop one from your desktop) and download folders into a directory. You see how many files, how much data and what already exists before anything moves; existing files are skipped unless you choose Overwrite; file names are made safe for your disk and a transfer never writes outside the folder you chose.
- **Delete, rename, copy and move** objects and folders, within a bucket or between buckets, from the right-click menu, the toolbar, the keyboard (`Delete`, `F2`, `Ctrl+C`, `Ctrl+X`, `Ctrl+V`) or by **dragging** them onto a folder, the path bar or a bucket (hold Ctrl to copy). Every delete, move or overwrite shows you the exact keys and how much is affected before it happens, unless you turn the copy/move confirmation off for the cases where nothing is in the way.
- **Create folders.**
- **Versions.** On a versioned bucket, see every version of an object, download one, restore one as the current version, remove a delete marker to bring an object back, or permanently delete a version behind its own confirmation.
- **Restore archived objects** from Glacier and Deep Archive, one at a time or many as a background job, with the retrieval tier and how long the restored copy stays. Archived objects show their restore state, and actions that need the data are disabled until it is back.
- **Tags** on objects and buckets: view, edit, and change them on many objects at once.
- **Lifecycle rules** with the full S3 model: filters by prefix, tags and size; moves to colder storage; expiration; noncurrent-version actions; cleanup of incomplete uploads. Every rule is summarised in plain language and every rule that deletes data is marked before you save.
- **Activity panel** for transfers and file operations: live speed, parts, time remaining, cancel, a list of anything that failed, and "show in folder".
- **Saved connections.** Keep an AWS profile or access keys under a name and connect with one click. Secret keys live in your operating system's keychain, never in a file.
- **Newest files** of the open bucket in the sidebar, wherever they are, filtered by age, type or search.
- **Desktop notifications** when a transfer or operation finishes while the app is in the background.
- **Settings** for part size, parallel parts per transfer and simultaneous transfers, with a live estimate of connections and memory before you save.
- **Light, dark or system theme**, four accent colours, and size and text-weight sliders.
- **Updates from inside the app.** Check for a new version, read its patch notes, install it. Only updates signed by this project are installed.

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

Creating or deleting buckets, presigned URLs, permissions, sync, turning versioning on or off, object lock, and dragging objects out of the app to the desktop. It is scoped small on purpose.

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
- Disconnecting while work runs asks whether to cancel it, and cancelling waits for every transfer to finish cleanly.

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

**Download a build.** Every version is built for Windows, macOS (Apple Silicon and Intel) and Linux by GitHub Actions. Grab the file for your system from the [Releases page](../../releases): either the bare executable or an installer. Each release comes with patch notes. From v0.3.0 on, the app can also update itself from Settings.

**Or build it yourself.** You need [Node.js](https://nodejs.org) 22+, [Rust](https://rustup.rs) (the exact toolchain is pinned in `src-tauri/rust-toolchain.toml` and installs itself), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
git clone https://github.com/yonatand/S3Explorer.git
cd S3Explorer
npm install
npm run tauri build
```

The executable lands in `src-tauri/target/release/`, with installers under `src-tauri/target/release/bundle/`.

## IAM permissions

S3 Explorer only does what your credentials allow. It needs no permissions outside S3, never creates or changes IAM resources, and makes no calls to other AWS services. Grant only the rows you want to use:

| To do this | The app calls | You need |
|---|---|---|
| See the list of buckets | `ListBuckets` | `s3:ListAllMyBuckets` on `*` |
| Open a bucket and browse folders | `HeadBucket` (to find the bucket's region), `ListObjectsV2` | `s3:ListBucket` on the bucket |
| See object details, download | `HeadObject`, `GetObject` | `s3:GetObject` on the objects |
| Upload, create a folder | `PutObject`, `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `AbortMultipartUpload` | `s3:PutObject` and `s3:AbortMultipartUpload` on the objects |
| Delete objects and folders | `ListObjectsV2`, `DeleteObjects` | `s3:ListBucket` on the bucket, `s3:DeleteObject` on the objects |
| Copy | `ListObjectsV2`, `HeadObject`, `CopyObject`; for objects over 5 GiB `CreateMultipartUpload`, `UploadPartCopy`, `CompleteMultipartUpload`, `GetObjectTagging` | `s3:ListBucket` and `s3:GetObject` on the source; `s3:ListBucket`, `s3:GetObject` and `s3:PutObject` on the destination (the app checks what already exists there and confirms each copy before a move deletes anything) |
| Move and rename | Copy, then delete the original | Everything for Copy, plus `s3:DeleteObject` on the source |
| Add a shared bucket | `HeadBucket`, `ListObjectsV2` | `s3:ListBucket` on that bucket |
| View and edit object tags | `GetObjectTagging`, `PutObjectTagging`, `DeleteObjectTagging` | `s3:GetObjectTagging`, `s3:PutObjectTagging`, `s3:DeleteObjectTagging` on the objects |
| View and edit bucket tags | `GetBucketTagging`, `PutBucketTagging`, `DeleteBucketTagging` | `s3:GetBucketTagging`, `s3:PutBucketTagging` on the bucket |
| View and edit lifecycle rules | `GetBucketLifecycleConfiguration`, `PutBucketLifecycleConfiguration`, `DeleteBucketLifecycle`, `GetBucketVersioning` | `s3:GetLifecycleConfiguration`, `s3:PutLifecycleConfiguration`, `s3:GetBucketVersioning` on the bucket |
| Upload or download a folder | The same calls as single uploads and downloads, plus `ListObjectsV2` to check what exists | Nothing beyond the rows above |
| See and download versions | `ListObjectVersions`, `HeadObject` and `GetObject` with a version id | `s3:ListBucketVersions` on the bucket, `s3:GetObjectVersion` on the objects |
| Restore a version as current | `CopyObject` (or multipart copy) from a version | `s3:GetObjectVersion` and `s3:PutObject` on the objects (plus the tagging permissions to carry tags) |
| Permanently delete a version | `DeleteObject` with a version id | `s3:DeleteObjectVersion` on the objects |
| Restore archived objects | `HeadObject`, `RestoreObject` | `s3:RestoreObject` on the objects |

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

Browse and download, nothing else. Upload, new folder, delete, rename, copy, move, tag editing and lifecycle rules will fail with "Access Denied", which is the point.

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

- **Tagged objects.** Copying keeps an object's tags, which needs `s3:GetObjectTagging` on the source and `s3:PutObjectTagging` on the destination. The tagging permissions are in the full policy above; drop them if you never use tags.
- **Shared buckets.** The owner of a bucket in another account grants you access with a bucket policy on their side; you need nothing in your own account beyond the rows above. Lifecycle rules and bucket tags on someone else's bucket are usually not granted, and the app says so.
- **Lifecycle rules** are a bucket-level setting with real consequences. Give `s3:PutLifecycleConfiguration` only to people who should be able to schedule deletion of the bucket's contents.
- **Versioned buckets.** Seeing and restoring versions needs `s3:ListBucketVersions` and `s3:GetObjectVersion`. `s3:DeleteObjectVersion` is the one permission in this app that allows an unrecoverable action; leave it out if you only want versions to be a safety net.
- **Archived objects.** Restoring needs `s3:RestoreObject`, and AWS bills each restore.
- **KMS-encrypted buckets (SSE-KMS).** Downloads need `kms:Decrypt` and uploads and copies need `kms:GenerateDataKey` on the bucket's KMS key. S3 calls KMS on your behalf; the app itself does not.
- **Versioned buckets.** Deleting adds a delete marker and older versions stay. The app never deletes specific versions, so it does not need `s3:DeleteObjectVersion`.
- **Archived objects (Glacier, Deep Archive).** They can be listed but not downloaded or copied until restored. The app does not restore objects.
- **Other S3-compatible storage** (MinIO, Cloudflare R2, SeaweedFS and others) has its own permission model. The table of calls above tells you what the app will ask the server to do.

The app remembers no more than it must: saved connections keep the secret key in your operating system's keychain, and an AWS profile is read from `~/.aws` each time you connect.

## Should you trust it?

Honest status, as of `v0.5.1`:

| | |
|---|---|
| Tested end to end on Windows against a local S3 server, including every delete, rename, copy and move path | yes |
| Destructive operations tested by comparing a full snapshot of the bucket before and after | yes |
| Unit tests, lint, and integration tests with checksum verification | yes |
| Independent AI code review of the delete, move and download code, with every finding fixed | yes |
| Builds and packages in CI for Windows, macOS and Linux | yes |
| Used against real AWS S3 by the author (browsing, transfers, and the v0.3.0 features) | yes |
| Shared buckets, tags, lifecycle rules, folder transfers and versions tested against real AWS S3 | **not yet** |
| Restoring from Glacier tested against a server that supports it (the local test server does not) | **unit tests only** |
| Lifecycle storage-class transitions tested against any server (the local test server refuses them) | **unit tests only** |
| In-app update installed for real on any platform | **not yet** |
| macOS and Linux builds actually run by a human | **not yet** |
| Reviewed line by line by a human | **no** |

Some things were done carefully because this tool can delete data and write to your disk:

- Your secret key is never written to a file by the app. A saved connection keeps it in the operating system's keychain; everything else remembers only the name, region, endpoint and access key id.
- Deletes and moves send exactly the keys shown in the confirmation dialog, byte for byte. See [How move, rename and delete stay safe](#how-move-rename-and-delete-stay-safe).
- Updates are installed only if they carry this project's signature.
- Lifecycle configurations are never saved over one that changed since you loaded it, and every data-deleting rule is called out before you save.
- File names coming from S3 are sanitized before they become local paths, so a hostile key can't write outside the folder you picked.
- The webview runs under a restrictive content security policy and all S3 traffic goes through the Rust side.

Still: it is young, AI-written software. Try it on a bucket you can afford to lose before trusting it with one you can't, and prefer credentials that only have the permissions you need.

## How it's built

- **[Tauri v2](https://tauri.app)** shell: the UI runs in the operating system's own webview, which is why the Windows executable is about 18 MB.
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
```

`npm run build` type-checks and bundles the frontend.

### How the vibe coding actually worked

One AI session acted as orchestrator. It picked the stack, wrote the contract between backend and frontend, then handed the two halves to separate agents that built them in parallel. A third agent drove the real executable end to end against a local S3 server, and a fourth did a read-only code review whose findings were fixed before the first tag. Every version since has gone the same way: contract first, halves in parallel, review, end-to-end run, then release.

The rules and playbooks the agents follow are checked in under [.claude/](.claude/), if you're curious what steering an AI-built project looks like in practice. The redesign in v0.4.0 came from a friend's pull request built the same way.

## Versioning

Releases are tagged `vMAJOR.MINOR.PATCH`. Pushing a tag builds the executables for all three platforms and publishes a release with the patch notes from [CHANGELOG.md](CHANGELOG.md).
