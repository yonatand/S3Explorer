# Changelog

Patch notes for every release. Versions are tagged `vMAJOR.MINOR.PATCH`.
The section for a version becomes the text of its GitHub Release.

## [Unreleased]

### New

- **A hidden game.** Click a server on the start screen five times: your first connection moves to the middle and the servers defend it against bugs, power surges, worms, ransomware and a DDoS boss. Esc leaves.

### Improved

- **Folder icons follow the accent colour.**

## [0.5.1] - 2026-10-07

### Fixed

- **The per-file progress bars inside a folder transfer never filled.** The byte counts beside them moved, but the bar itself stayed empty because of a styling mistake. The bars now fill as each file downloads or uploads.

## [0.5.0] - 2026-10-06

Whole folders, and your files' history. This version moves folders in and out in one go, shows and restores object versions, brings archived objects back, and lets you stop running work when you disconnect.

### New

- **Upload a folder.** Pick a folder, or drop one from your desktop. You see how many files and how much data it is, where it will go (editable), and what already exists there, with the usual Skip or Overwrite choice. Sub-folders become prefixes; shortcuts and junctions are skipped and listed.
- **Download a folder**, or several, into a directory you choose. The folder structure is recreated and file names are made safe for your disk. Existing files are skipped unless you choose Overwrite. Two keys that would land on the same file name fail the second one instead of overwriting.
- **One Activity row per folder transfer**, with overall progress, the files currently moving, and every file that failed. Cancel stops the rest; finished files stay. Folder transfers always confirm, whatever the copy/move setting says.
- **Versions.** On a bucket with versioning, the details panel shows every version of the selected object: date, size, which one is current, and delete markers. Download a version, restore a version as the current one (the current one becomes a previous version; nothing is deleted), remove a delete marker to bring an object back, or permanently delete a version behind a confirmation that says it cannot be undone.
- **Restore archived objects.** Objects in Glacier or Deep Archive show their restore state. Restore one with a retrieval tier and a number of days, or many at once as a background job. Download, copy and move are disabled on an archived object until it is restored, and say why.
- **Disconnect while work is running** now asks: cancel it and disconnect, let it finish in the background, or stay connected.

### Improved

- Desktop notifications decide by the window's real focus, so a notification is not suppressed just because the page thought it was focused.
- Deleting a saved connection also forgets the buckets you had added to it.
- Queued files in a large folder transfer start in order without the queue slowing down as it grows, and a 5,000-file transfer keeps the window responsive.

### Fixed

- A folder download could write through a shortcut, junction or symlink inside the destination folder, landing files somewhere else. Such paths are now refused per file.
- Cancelling work on disconnect could freeze the whole app. A lock-ordering bug in the transfer manager is fixed and guarded by a stress test.
- Uploading a folder to the top of a very large bucket no longer lists the entire bucket to check for conflicts.

### Good to know

- Folder transfers are limited to 50,000 files and 1 TiB each; split larger folders by sub-folder.
- Permanently deleting a version is the one action in the app that cannot be undone by anything. The confirmation says so and names the version.
- Restoring from Glacier or Deep Archive is billed by AWS and takes from minutes (Expedited) to up to two days (Bulk from Deep Archive). Expedited is not available for Deep Archive.
- Restoring a version copies that version onto the key, so it keeps that version's metadata, content type, storage class and tags.
- Versions, archive restore and folder transfers were tested end to end against a local S3 server that supports versioning but not restores, so the restore itself is verified only up to the request.

## [0.4.1] - 2026-10-06

### Changed

- **Shared buckets stay out of the way until you use them.** The sidebar no longer shows a "Shared with me" section when you have none. To add a bucket shared from another account, use the small "+" next to the reload button above the bucket list; the section appears once a shared bucket exists.

## [0.4.0] - 2026-10-06

The buckets update. Manage buckets, not only the files in them: shared buckets from other accounts, tags on buckets and objects, a full editor for lifecycle rules, drag and drop, and a new look.

### New

- **Shared buckets.** A bucket shared with you from another account does not appear in your bucket list. Add it by name, `s3://` address or ARN under "Shared with me" in the sidebar, and use it like any other bucket. Removing it from the list only forgets it here.
- **Tags.** See an object's tags in the details panel and edit them. Edit tags on many objects or a whole folder at once, adding, changing and removing specific tags, or replacing them all. Bucket tags are in the bucket menu. Tags set by AWS itself are shown but can't be changed here.
- **Lifecycle rules.** Edit a bucket's lifecycle configuration with the full set of S3 rules: filters by prefix, tags and object size; moves to colder storage; expiration; noncurrent-version actions; cleanup of incomplete uploads. Each rule is summarised in plain language, every rule that deletes data is marked, and before saving you see exactly what is added, removed and changed. If someone else changed the rules while you were editing, nothing is overwritten.
- **Drag and drop.** Drag files and folders onto a folder, onto the path bar or onto a bucket to move them. Hold Ctrl (Option on macOS) to copy instead; the badge following the pointer tells you which.
- **A setting to skip the copy and move confirmation** when nothing is in the way, in Settings under Behavior. You are still asked whenever something would be overwritten, and deleting always asks.
- **A new look.** A marigold accent on neutral surfaces in both themes, new typefaces, and a new icon with a white bucket on a yellow tile. A marigold accent on neutral surfaces in both themes, new typefaces, and a new icon with a white bucket on a yellow tile.
- **A start screen for your connections.** Saved connections are tiles: drag them into the order you want, right-click one for Connect, Edit and Delete, and scroll a page of six at a time when you have more. Behind them, pulses travel from small servers into your connections.
- **Newest files.** The lower part of the sidebar lists the files most recently changed in the open bucket, wherever they are, with the folder each one is in. Narrow the list to the last hour, 24 hours or 7 days, to chosen file types, or by searching. Click a file to open its folder, or download it directly. It looks again by itself after an upload. The scan looks at up to 20,000 files and says so when it stops there.
- **Desktop notifications** when your transfers are done, or a copy, move or delete finishes, while the app is in the background. Turn them off in Settings under Notifications.
- **Switch between light and dark from the top bar**, without opening Settings.
- **The window title shows the connection** you are in.
- **Resizable sidebar.** Drag its right edge to set the width, and the divider between the buckets and Newest files to set how the height is shared. Double-click either to reset.
- **Accent colour** in Settings under Appearance: yellow, green, blue or red.
- **Size and text weight** sliders in Settings under Appearance. Size scales the whole window, text and icons together.

### Improved

- **New connections are saved by default**, under a suggested name if you do not type one. Untick the box to connect without saving.
- **The details panel leads with size, date and path.** Storage class, ETag, content type and metadata are under "More details".
- **Before a bucket is open**, the main area explains what to do next instead of showing a disabled toolbar.
- **The logo in the top bar** takes you back to your connections.
- **Copy the current path** with the button at the end of the path bar.
- On a large window the side panels are wider.
- Queued transfers and operations now start strictly in the order you requested them, whatever the machine is busy with.

### Fixed

- **The taskbar and Start menu showed the old Tauri icon** on Windows even though the window showed the app's icon. The app now sets its large icon itself, and the installer tells Windows the program changed. A pinned icon from an older version may need to be re-pinned once.
- Progress updates could arrive twice in a few milliseconds after a busy moment.

### Good to know

- **Lifecycle rules act on their own.** Once saved, S3 applies them at its next daily run without asking again, and objects deleted by a rule can't be recovered unless versioning keeps older versions. The editor shows every deleting rule in red for that reason.
- A lifecycle rule with a date in the past is not a historical no-op: every matching object, and every new one, is deleted or moved at the next daily run. The editor says so.
- Bucket settings take a moment to propagate on AWS. If a save reads back the old configuration, the app waits and checks again rather than overwriting anything.
- Lifecycle rules and bucket tags on a bucket shared from another account are usually not permitted; the app says so instead of failing.
- Other S3-compatible services support tags and lifecycle rules to varying degrees. When a server refuses a feature, the app tells you and changes nothing.
- Tested end to end against a local S3 server. The author uses the app against real AWS; the new bucket features have not yet been tried there.

## [0.3.0] - 2026-10-05

Manage your files, not just look at them. This version adds delete, rename, copy and move, saved connections, a theme switch, in-app updates and a new icon.

### New

- **Delete, rename, copy and move** for objects and folders, within a bucket or between buckets. Use the right-click menu, the toolbar, or the keyboard: `Delete`, `F2`, `Ctrl+C`, `Ctrl+X`, `Ctrl+V`.
  - Before anything is deleted, moved or overwritten you get a confirmation that lists the exact keys and how many objects and bytes are affected.
  - If something already exists at the destination you choose: skip it or overwrite it. Nothing is overwritten unless you pick that.
  - These run in the background and show up in the bottom panel, now called **Activity**, next to your transfers, with progress, cancel, and a list of anything that failed.
- **Saved connections.** Save an AWS profile or access keys under a name and connect with one click. Secret keys go into your operating system's keychain, never into a file.
- **Light, dark or system theme**, in Settings under Appearance.
- **Updates from inside the app.** Settings has an Updates tab: check for a new version, read its patch notes, and install it. You can also have the app check when it starts. Only updates signed by this project are installed.
- **A new icon.**

### Improved

- **Downloads use far less memory with large parts.** Parts are written to disk as they arrive. With 100 MiB parts and 32 in parallel, memory dropped from about 3.2 GiB to about 100 MiB, and large-part downloads got faster on fast disks.
- **A dropped connection no longer restarts a part.** The download resumes from where it stopped, and the progress bar no longer jumps backwards.
- **Sizes and speeds are labelled correctly** as KiB, MiB, GiB and MiB/s. The numbers were always binary; the labels said MB and GB.
- The memory estimate in Settings matches the new behavior.

### Fixed

- **Uploads on slow connections failed after 30 seconds.** A timeout wrongly counted the time spent sending the file.
- Small downloads are now flushed to disk before they are marked complete.
- A download that keeps getting cut off now gives up with an error instead of retrying forever, and an upload whose connection silently dies no longer waits forever.

### How move and delete keep your data safe

S3 has no real move or rename, so the app copies and then deletes the original. It does that carefully:

- An original is deleted only after its own copy is confirmed, and not if the original changed in the meantime.
- A cancelled or failed move leaves every object in exactly one place.
- A request that would write into its own source, such as moving a folder into itself, is refused.
- Keys are never altered: spaces, unicode and unusual characters are sent exactly as they are.

### Good to know

- Updating from 0.2.0 to this version is still a manual download. In-app updates work from this version onward.
- On Windows, an in-app update installs the app. If you run the standalone exe, download the new one instead.
- On Linux, saving a connection with a secret needs a keyring service such as GNOME Keyring or KWallet.
- Disconnecting does not stop transfers or file operations that are already running; they finish in the background.
- On versioned buckets, delete adds a delete marker and older versions remain.
- Archived objects (Glacier, Deep Archive) cannot be copied or moved until restored.
- Copies keep content type, metadata, storage class and tags. They do not keep ACLs.
- Delete, rename, copy and move have been tested thoroughly against a local S3 server, but not yet against real AWS. macOS and Linux builds are still untried by a human.

## [0.2.0] - 2026-10-05

Settings. You can now tune how transfers run instead of living with fixed numbers.

### New

- **Settings dialog**, opened with the gear button on the connect screen or in the top bar. It works before you connect.
- **Part size**: Auto, or a custom size from 1 to 256 MiB. Auto is what the app did before: 8 MiB parts, and 16 MiB for downloads over 1 GiB.
- **Parallel parts per transfer**: 1 to 32 (default 8).
- **Simultaneous transfers**: 1 to 10 (default 4). The rest wait in a queue.
- **Live impact summary** while you edit: total connections, estimated peak download memory, and how many parts a 1 GiB file would be split into. It warns you when the memory estimate gets large.
- Settings are saved on your machine and survive restarts. A missing or damaged settings file falls back to defaults instead of breaking startup.

### How changes apply

- Part size and parallel parts apply to transfers that start after you save. Transfers already running keep the values they started with.
- The simultaneous-transfers limit applies to the queue immediately. Raising it starts queued transfers right away. Lowering it never interrupts a running transfer.
- Uploads always use parts of at least 5 MiB, because S3 requires it. A smaller custom size still applies to downloads.

### Changed

- Queued transfers now start strictly in the order they were added.
- An object is downloaded in a single request when it is no larger than one part.

### Fixed

- The transfers panel could briefly show one more running transfer than the limit while one finished and the next started.

## [0.1.0] - 2026-10-05

The first working version. Vibe coded, so I won't have to pay for an S3 explorer. :)

### What you can do

- **Connect** with an AWS profile from `~/.aws` or with access keys. Add a custom endpoint to use MinIO, Cloudflare R2, SeaweedFS, LocalStack and other S3-compatible storage.
- **List buckets**, including ones in other regions.
- **Browse folders and objects** with size, last modified, storage class, ETag, content type and user metadata. The table stays smooth with thousands of rows and loads more as you scroll.
- **Download in parallel parts.** Objects over 8 MiB are split into 8 MiB byte ranges (16 MiB for objects over 1 GiB) and fetched up to 8 parts at a time.
- **Upload** by button or drag and drop, with multipart upload for files over 8 MiB.
- **Create folders** and **delete folders** recursively, with a confirmation that shows the exact prefix.
- **Transfers panel** with live speed, parts done, time remaining, cancel, and "show in folder". Up to 4 transfers run at once and the rest queue.
- Sort, filter, multi-select, right-click menu, keyboard navigation, dark and light themes.

### Built to be careful with your data

- A download fails instead of mixing two versions if the object changes midway, and received bytes are checked against the expected size.
- File names from S3 are sanitized before they become local paths, so a hostile key can't write outside the folder you chose.
- Two downloads can't write to the same file at the same time.
- Stalled connections time out and the affected part is retried.
- Cancelled or failed multipart uploads are aborted, so they don't linger and cost you storage.
- Your secret key is never written to disk by the app.

### Known limitations

- Not yet tested against real AWS S3, only against a local S3-compatible server.
- macOS and Linux builds are produced by CI and have not been tried by a human.
- No deleting or renaming of single objects, no copy or move, no bucket creation, no versioning or presigned URLs.
- Part size and concurrency are fixed. Settings for them are coming in the next version.
- Dropping a folder onto the window does not upload it recursively.
