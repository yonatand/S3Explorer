# Changelog

Patch notes for every release. Versions are tagged `vMAJOR.MINOR.PATCH`.
The section for a version becomes the text of its GitHub Release.

## [Unreleased]

## [0.9.2] - 2026-10-19

### Fixed

- **The taskbar icon now really follows the accent colour in the installed app.** v0.9.1 fixed it only for development builds; installed builds have an application identity that made Windows take the button's icon from the Start-menu shortcut. The running window now carries its own identity per accent, so the button shows the accent icon at start and changes with it. A shortcut pinned to the taskbar keeps its own icon.

## [0.9.1] - 2026-10-19

### New

- **Network locations.** A local pane can open a network share: pick a saved Network Location or a mapped drive from `Alt+F1` / `Alt+F2` or the sidebar, or type a `\\server\share` path in the path field. Nothing on a share is ever deleted by the app (shares have no recycle bin), so a move from a share to S3 uploads and leaves the files in place.

### Fixed

- **The taskbar icon did not follow the accent colour**, only the title-bar icon did.

## [0.9.0] - 2026-10-14

### New

- **Total Commander keys by default.** `F5` copies and `F6` moves to the other pane, `Shift+F6` renames, `F7` creates a folder, `F8` or `Delete` deletes, `F2` refreshes, `Alt+F7` searches and `Ctrl+T` opens a new tab (on macOS, `Cmd` wherever this says `Ctrl`). If you already use S3 Explorer, nothing changes: your keys are kept exactly as they were, and a one-time message tells you so. **Reset all** in Settings → Keyboard switches you to the Total Commander layout. `F1` always shows the keys that apply to you. Thanks to EthanLerner1 for the request (#13).
- **Your computer in a pane.** `Alt+F1` / `Alt+F2`, or the new "This computer" group in the sidebar, turn the left or right pane into a view of a drive or folder on your machine. Copying from a bucket into it downloads, copying from it into a bucket uploads, with the usual preview and conflict choice. Move does the same and then removes the originals, but only the ones that finished transferring: an object in S3 is deleted only if it is still exactly the version that was downloaded (otherwise it is left in place and reported as changed), and local files go to the recycle bin. New folder, rename, delete (always to the recycle bin, never permanently) and folder sizes work on the local side too, and `Ctrl+.` shows hidden files. Links and junctions are shown but never followed. Copying or moving between two local folders is left to your system's file manager.
- **Edit the path.** `Ctrl+L`, or a click on the empty part of the path bar, turns it into a text field: type or paste an `s3://` address, a folder in the current bucket, or a local path, and press Enter. A path to a local file opens its folder with the file selected.
- **Sync the other pane.** `Ctrl+Shift+Right` / `Ctrl+Shift+Left` make the other pane show the same bucket and folder, or the same local folder, as the one you are in.
- **The window icon follows your accent colour.** The title bar, taskbar button and Alt+Tab icon now match the accent you picked. A shortcut pinned to the taskbar or Start menu keeps the installed yellow icon.
- **Open the app from the command line.** `s3explorer [--connection <name>] [<path or s3://…>]` opens the app at a local folder or file, or at a bucket and folder, connecting with the saved connection you name (or the one you used last). If the app is already running, the location opens in that window instead of a second copy of the app. `s3explorer --help` shows the usage.
- **Type to jump.** Typing in a file list moves to the first row whose name starts with what you typed, as in Windows Explorer; pressing the same letter again steps through the rows that start with it. This replaces typing to start a search: the search box is now reached with `Ctrl+F`, `/` or `Alt+F7`.
- **Type-ahead in the source menu.** In the `Alt+F1` / `Alt+F2` menu, type a few letters to jump to a bucket or a drive (`d` picks `D:\`), then press Enter to open it.

### Improved

- **Switching panes and tabs is much faster.** In a folder of 10,000 files, switching tabs went from 255 ms to 21 ms in development builds and from 16 ms to 4 ms in the released app, and switching panes no longer redraws the rest of the window.
- **Newest files shows 40 rows at first**, with Show more for the rest, and keeps showing the last bucket's list while you work in a local pane.
- **The details column stays in place** when you switch to a local pane, so the layout no longer jumps.
- **Enter confirms copy and move.** The copy, move, folder transfer and pane-to-pane dialogs open with their action button ready, so Enter goes ahead and Escape cancels. Delete and recycle-bin confirmations still start on Cancel, so a stray Enter never deletes anything.
- **Pause and resume are one button** that stays in the same place on an Activity row, and `Space` pauses or resumes the row you are on.
- **Files are sorted by name, A to Z, every time the app starts**, whatever sort you used last time.
- **Sorting by Size puts folders in order of their calculated size.** Folders you have not calculated come after them, by name.

## [0.8.0] - 2026-10-13

### New

- **Tabs.** Keep several folders open in each pane and switch between them instantly. Middle-click a folder or choose **Open in new tab**; `Ctrl+N` duplicates the current tab, `Ctrl+W` closes it (`Cmd+Shift+W` on macOS), `Ctrl+Tab` / `Ctrl+Shift+Tab` (or `Ctrl+PageDown` / `Ctrl+PageUp`) move between tabs, and `Ctrl+Shift+T` brings back the last one you closed. Each tab keeps its own selection, filter, search results and back/forward history; drag tabs to reorder them. When you had more than one tab open, your tabs come back the next time you connect with the same connection.
- **Bookmarks bar.** Star a folder in the path bar, press `Ctrl+Shift+D`, or right-click folders or a bucket and choose Bookmark, and it appears as a chip in a bookmarks bar under the toolbar, one click away (middle-click or `Ctrl`+click opens it in the other pane). Chips that don't fit wait under » at the end of the bar. Bookmarks are kept per connection; drag chips to reorder, and rename or remove them from the right-click menu.
- **See inside a file without downloading it.** Selecting a text file or an image shows a preview in the details panel: JSON is pretty-printed, CSV and TSV show as a table, images fit the panel (large ones load when you ask). Press `F3` or choose **Quick look** from the right-click menu for a big view, and use the arrow keys to flip through files while it is open. Only the start of a large text file is read (256 KiB), never the whole object. If you would rather not fetch anything on selection, turn off Settings → Behavior → "Preview files automatically" and click Preview when you want one.
- **Folder size.** Right-click a folder and choose Calculate size, or use Calculate in the details panel, to see how many objects and how many bytes it holds. Select several folders to get their total. The size then shows in the file list too, stays for the session, and is cleared as soon as anything inside the folder is uploaded, deleted, moved or copied in this app (changes made elsewhere, by another app or person, are not seen until you recalculate). Very large folders stop counting at 200,000 keys and say "at least"; Cancel stops a count at any time.
- **Edit content type and metadata.** In an object's details, More details → Edit (or `Ctrl+M` on Windows and Linux) changes its content type, Cache-Control, Content-Disposition and user metadata. You see every change (before → after) before it is applied; the content, storage class, encryption and tags stay as they are, and if someone changed the object since you opened the dialog nothing is written. On a versioned bucket the edit is saved as a new version. Objects in Glacier or Deep Archive can't be edited, because the copy would archive them again.
- **History.** The Activity panel has a History tab next to Now (`Ctrl+H`, `Cmd+Shift+H` on macOS): finished uploads and downloads, folder transfers, and file operations too (copy, move, rename, delete, tag changes and archive restores), kept after you close the app (the last 400 transfers and 100 file operations). It shows the current connection's history, or All; narrow it to transfers or file operations, filter by name or path, and see when each one finished and what failed. From a transfer you can open the file, show it in its folder, go to the object, or download or upload it again; from a file operation you can go to where it went and copy its source or destination path. Actions that touch a bucket are offered only on the connection the entry was recorded on. Clear history empties the list without touching any file.
- **Pause and resume transfers.** Pause a download, an upload or a whole folder transfer from its row in Activity (or its right-click menu), and resume it later: it continues with the parts it has not finished, and a paused transfer leaves its slot to the next one in line. "Pause all" and "Resume all" are in the Activity bar, and can be given a shortcut in Settings → Keyboard. If the object (download) or the local file (upload) changed while paused, the transfer fails safely instead of mixing old and new data. Pausing lasts until you quit: transfers still paused then are cancelled cleanly.
- **Speed limits for transfers.** Settings → Transfers can cap download and upload speed (from 64 KiB/s up), shared by every running transfer, so the app no longer fills your connection. A change applies to running transfers within a second, and the Activity bar shows when a limit is on. Copies and moves inside S3 are not limited, since they don't use your connection.
- **You are told about updates.** When a newer version is out, a window opens at startup with what changed and an Install button. Later hides it until an even newer version is out, and a small "vX.Y.Z available" pill in the title bar reopens it. The startup check is now on by default for new installs; if you already turned it off, it stays off (Settings → Updates). Nothing is installed until you click Install.
- **What's new after an update.** The first launch of a new version shows its patch notes, so you know what changed in what you just installed.
- **The search box has its own row** under the toolbar, as wide as the window, with the folder / whole-bucket choice at its right. While you type, a hint says whether you are searching this folder or the whole bucket, that results come half a second after you stop, and that Enter searches right away.
- **A second hidden game.** Type a certain word on the start screen and see what happens. It is downloaded only when you start it, Esc leaves, and it never touches your buckets or files.

### Improved

- **The workspace is complete as soon as you connect.** The toolbar and the search row are there before you open a bucket (greyed out until you do), with "Pick a bucket" in the middle, so nothing jumps around when you pick one. The details panel appears once a bucket is open.
- **Every new action is in Settings → Keyboard** and on the `F1` cheat sheet, including the ones without a default key (Calculate folder size, Pause all, Resume all), so you can bind them.
- **Keyboard files move between systems.** Importing bindings exported on macOS into Windows or Linux (or the other way round) treats that system's default keys as defaults, not as changes.

### Fixed

- **Quitting the app while transfers ran could leave work half done in the bucket.** An upload interrupted by quitting left its unfinished multipart upload behind (S3 keeps, and bills, its parts until it is aborted) and a download left its temp file. Quitting now cancels every running, queued or paused transfer, folder transfer and file operation cleanly, waiting at most 10 seconds.
- **The keyboard shortcuts sheet (`F1`) and Settings → Keyboard can be scrolled with the keyboard** (arrow keys, Page Up / Page Down, Home, End).

## [0.7.0] - 2026-10-11

### New

- **Two panes.** Split the window into two explorer panes (toolbar button or `Ctrl+2`), browse a different folder or bucket in each, and copy or move between them by dragging rows across, with `Ctrl+Shift+C` / `Ctrl+Shift+X`, or from the right-click menu. Same previews and confirmations as before; `Tab` switches panes.
- **Keyboard for everything, your way.** Every action has a shortcut (press `F1` or `?` for the list), and Settings → Keyboard lets you rebind any of them, export them to a file and import them back. Typing in the file list starts a search; `Alt+Left` / `Alt+Right` and the mouse's back and forward buttons go back and forward; `F5` refreshes.
- **Search as you type.** Results appear half a second after you stop typing; `Enter` still searches at once.

### Fixed

- **Profiles signed in with `aws login` were shown as having no credentials.** The AWS CLI's newer `aws login` command (2.32+) stores a `login_session` in the profile instead of keys; the app now recognises it and uses the signed-in session, refreshing it as the CLI does.
- **`F5` reloaded the whole window.** It now refreshes the folder, like the Refresh button, and no key can reload the app any more.

## [0.6.0] - 2026-10-08

### New

- **Search in a bucket.** Type in the toolbar box and press Enter: words, `"a phrase"`, `-not`, `tag:key=value` or `tag:key`, and a `folder/part` path all work together. Search the current folder or the whole bucket. Folders and objects both come up; paste a full path or an `s3://` address and the exact match comes first. Select results and download, delete, copy, cut, rename or tag them as you would in the table, or press Enter to jump to one. Searches are bounded (50,000 objects, 2,000 tag lookups) and say so when they stop early.
- **Right-click an Activity row.** Downloads offer Open file, Show in folder, Go to object and Copy key / local path; folder transfers Open folder; jobs Copy failures; everything can be cancelled or removed from the menu, with the keyboard too.
- **Choose your file manager.** Settings → Behavior can point "Show in folder" and "Open folder" at a program of your choice (Total Commander, Files, Dolphin, …) with `{path}` and `{dir}` placeholders, and try it before saving.
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
