# Backup and restore

Corolla Fix Helper keeps everything local: one SQLite database file
(`DATABASE_FILE`, default `server/data/corolla-fix-helper.db`) and one uploads
folder of uploaded PDFs and saved attachment images (`UPLOADS_DIR`, default
`server/uploads/`). A backup captures
both, and restore puts both back. An export you cannot restore is not a real
backup, so the two halves are documented together here.

## What a backup contains

A backup is a single gzipped tar archive named
`corolla-fix-helper-backup-<timestamp>.tar.gz` whose root holds:

```
database/<name>.db   the SQLite database file
uploads/...          a copy of every uploaded PDF and attachment image
manifest.json        format version + creation time (added by the CLI/drill;
                     older archives from Settings omit it and still restore)
```

## Export a backup

You can produce a backup two ways:

- **From the app:** open **Settings → Export backup** and download the
  `.tar.gz`. This streams the database and uploads straight to your browser.
- **From the command line** (handy for scripts/cron):

  ```bash
  cd server
  node -e "import('./src/services/backupService.js').then(m => m.createBackupArchive({ databaseFile: process.env.DATABASE_FILE || 'data/corolla-fix-helper.db', uploadsDir: process.env.UPLOADS_DIR || 'uploads', outFile: 'corolla-fix-helper-backup.tar.gz' }))"
  ```

Store the resulting file somewhere off the machine (another disk, a synced
folder, etc.). Use sample or fake PDFs before sharing a backup.

## Restore a backup

Restore is **CLI-only**. There is no restore button in the app, and adding one
is not planned: restoring replaces the live database while the server holds it
open, so it has to happen with the server stopped. Settings shows these same
instructions next to the export button so the two halves are discoverable
together.

> **Stop the server first** (or restart it afterward). The running app keeps a
> live SQLite connection open on the database file, and restore replaces that
> file on disk.

Run the restore CLI with the path to a backup archive:

```bash
npm run restore -- "/path/to/corolla-fix-helper-backup-2026-06-15T....tar.gz"
```

Run it from the project root (that is where the `restore` script lives). The
path argument may be absolute or relative to the folder you run it from — it is
resolved with `path.resolve`, so the archive does not need to sit anywhere in
particular. The command takes exactly one argument and **starts immediately;
there is no confirmation prompt**, and a successful restore replaces the
documents, symptoms, procedures, notes, and uploaded files currently in the app
with the ones in the archive. You do not need to take a safety backup by hand —
step 3 below does it for you.

Restore targets the same `DATABASE_FILE` / `UPLOADS_DIR` the app uses, so set
those environment variables the same way you do for the server if you have
customized them.

What it does, in order:

1. **Extract** the archive into a temporary working directory.
2. **Validate** it — the archive must contain a `database/` directory with
   exactly one database file whose first 16 bytes are the SQLite header, a
   `uploads/` directory, and (if present) a `manifest.json` whose format version
   this app understands. A bad or incompatible archive is rejected here, before
   anything on disk is touched.
3. **Snapshot** the current database (plus any `-wal`/`-shm` sidecars) and
   uploads into a `pre-restore-<timestamp>` folder next to the database file.
4. **Swap** the validated database and uploads into place. The database is
   written to a temporary file on the target filesystem and then renamed over
   the live file (atomic within a directory); stale WAL/SHM sidecars are removed
   so the restored database is not reinterpreted through an old write-ahead log.

On success the CLI prints where the pre-restore snapshot was kept. Once you have
confirmed the app shows the restored documents, symptoms, procedures, notes, and
that PDFs open, you can delete that snapshot folder.

## Safety and atomicity

Restore is **fail-closed**:

- It validates the archive **before** modifying any live data, so a corrupt or
  incompatible archive cannot start a partial overwrite.
- It snapshots the current data **before** swapping, so the prior state is
  always recoverable.
- If the swap fails partway through, restore **rolls back** from the snapshot
  and re-raises the error — your database and uploads return to their previous
  contents.

## If a restore fails

- The CLI exits non-zero and prints `Your existing data was left in place.`
  Nothing further is needed — the app is unchanged.
- If a failure happened mid-swap, restore already rolled back from the snapshot.
  You can also recover manually from the `pre-restore-<timestamp>` folder: copy
  its `database/<name>.db` back over `DATABASE_FILE` and its `uploads/` contents
  back into `UPLOADS_DIR` while the server is stopped.

## Prove it works: the backup + restore drill

`npm run backup:drill` exercises the whole round trip on a throwaway temp
install, so it never touches your real data. It seeds fake documents, symptoms,
procedures, notes, and a PDF; exports a backup; wipes the database and uploads;
restores; and asserts the row counts and the PDF bytes came back intact. It
exits non-zero if anything fails. Run it after changing backup or storage code.
