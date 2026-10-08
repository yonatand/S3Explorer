# Product scope (v1)

The user defined v1 precisely. Deliver exactly this, do not widen it:

1. Connect with an AWS profile or static credentials (optional custom endpoint for MinIO/R2).
2. List buckets.
3. Browse objects and folders with basic metadata (size, last modified, storage class, etag).
4. Upload objects (multipart for large files).
5. Download objects (parallel ranged parts).
6. Create folders and delete folders (recursive).

7. Settings view with transfer tuning: part size, parallel parts per transfer, simultaneous
   transfers (added on request after v1; see "Settings" in `docs/CONTRACT.md`).

8. (v0.3.0) Delete, rename, copy and move for objects and folders, run as background jobs.
9. (v0.3.0) Light / dark / system theme switch in Settings.
10. (v0.3.0) Saved connections, with secrets in the OS keychain only.
11. (v0.3.0) Check for updates from GitHub Releases and install them (signed packages only).
12. Desktop notifications when a transfer or job finishes while the app is in the background
    (added on request after v0.3.0; see "Desktop notifications" in `docs/CONTRACT.md`).
13. Newest files of the open bucket in the sidebar, found by a bounded scan (added on request after
    v0.3.0; see "Newest files" in `docs/CONTRACT.md`).

14. (v0.4.0) Shared buckets added by name (buckets from another account that ListBuckets does not show).
15. (v0.4.0) Tags on buckets and objects: view and edit, single and bulk (bulk as a background job).
16. (v0.4.0) Bucket lifecycle configuration editor, full S3 rule model, edited as a whole with a
    conflict check and a confirmation naming every rule that deletes data.
17. (v0.4.0) A setting to skip the copy/move confirmation when nothing conflicts; delete always confirms.
18. (v0.4.0) Drag and drop rows onto folders, the path bar or buckets to move; Ctrl/Option copies.

19. (v0.5.0) Upload and download whole folders as batches with a preview and conflict choice.
20. (v0.5.0) Object versions: list, download a version, restore a version as current, permanently delete
    a version (own confirmation).
21. (v0.5.0) Restore archived objects (Glacier / Deep Archive), single and bulk as a job; restore status shown.
22. (v0.5.0) Disconnect can cancel running work; notifications use OS window focus; deleting a saved
    connection forgets its added buckets.

23. (v0.6.0) Search in a bucket: words, phrases, exclusions, `tag:key=value` and path terms over a bounded
    scan of the current folder or the whole bucket (see "Search in a bucket" in `docs/CONTRACT.md`).
24. (v0.6.0) A right-click menu on every Activity row: open the downloaded file or folder, show in folder, go
    to the object, copy key / local path / failures, cancel, remove.

Explicitly **not** in scope: bucket creation/deletion, presigned URLs, permissions/ACL editing, sync,
dragging objects out of the app, editing versioning settings, object lock / legal hold.
If a task seems to need one of these, stop and ask the user instead of adding it.
