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
3. **Copy** the validated database and uploads beside the live ones, as
   `<DATABASE_FILE>.restore-<timestamp>` and `<UPLOADS_DIR>.restore-<timestamp>`.
   Only new paths are written, so a failure here (a full disk, say) changes
   nothing.
4. **Swap** using renames only. The live uploads folder is renamed to
   `<UPLOADS_DIR>.pre-restore-<timestamp>` beside it. The live database, together
   with any `-wal`/`-shm` sidecars (after an unclean stop the newest rows can live
   only in the `-wal`), moves into a `pre-restore-<timestamp>/database/` folder
   next to the database file. Then the copies from step 3 are renamed into place.
   The uploads go first: on Windows, a PDF open in another program makes that
   rename fail before anything has moved.

On success the CLI prints where the previous database and uploads were kept.
Once you have confirmed the app shows the restored documents, symptoms,
procedures, notes, and that PDFs open, you can delete those two folders.

## Safety and atomicity

Restore is **fail-closed**:

- It validates the archive **before** modifying any live data, so a corrupt or
  incompatible archive cannot start a partial overwrite.
- It never deletes or overwrites your current database, its sidecars, or your
  uploads. Each is moved aside whole, and after a successful restore it stays
  there as the previous data.
- If any step of the swap fails, restore moves everything back the same way, by
  renaming. A rollback never deletes or overwrites anything either: whatever
  it cannot move back stays where it is, and the CLI tells you where.

## If a restore fails

The CLI exits non-zero and says which of three things happened:

- **"Nothing was changed"**: the restore stopped before moving anything, and
  your database and uploads are exactly as they were. The usual cause on Windows
  is a file in use. Stop the app, close any program that has one of your
  uploaded PDFs or the database open, and run the restore again.
- **"The restore was rolled back"**: something had been moved, and all of it was
  moved back. Nothing was deleted and the app is unchanged.
- **"The rollback also failed"**: something could not be moved back. Nothing was
  deleted. The CLI lists where your previous database and uploads now are,
  followed by numbered steps (rename the restored copy out of the way, then move
  each original back). Stop the app and follow them. Do not delete any
  `pre-restore` folder until the app shows your data again.

## Undo a restore that succeeded

If you restored the wrong archive and still have the right one, restore that
one with `npm run restore`. That is the safest undo, because the CLI handles
the SQLite sidecar files for you.

To go back to the data you had *before* the restore, put the two pre-restore
folders back by hand. A SQLite database in WAL mode is the `.db` file **plus**
its `-wal`/`-shm` files: the `-wal` can hold the newest committed rows, and a
`-wal` left over from a different database gets replayed into the wrong one.
Always move those files together, and never copy the `.db` file alone.

1. Stop the app (`Ctrl+C`) and wait for it to exit.
2. Move the restored database out of the way: rename `DATABASE_FILE` **and**
   any `DATABASE_FILE-wal`, `-shm` or `-journal` next to it, for example by
   adding `.unwanted` to each name.
3. Move everything in `pre-restore-<timestamp>/database/` (the `<name>.db` and
   any `<name>.db-wal` / `-shm` / `-journal` beside it) back next to
   `DATABASE_FILE`, keeping the names exactly as they are.
4. Rename `UPLOADS_DIR` out of the way (for example `uploads.unwanted`), then
   rename `<UPLOADS_DIR>.pre-restore-<timestamp>` to `UPLOADS_DIR`.
5. Start the app and check your documents, notes and PDFs. Then delete the
   `.unwanted` items and the empty `pre-restore-<timestamp>` folder.

A restore that *failed* needs none of this. The CLI either changed nothing,
moved everything back, or printed the exact moves to make.

## Prove it works: the backup + restore drill

`npm run backup:drill` exercises the whole round trip on a throwaway temp
install, so it never touches your real data. It seeds fake documents, symptoms,
procedures, notes, and a PDF; exports a backup; wipes the database and uploads;
restores; and asserts the row counts and the PDF bytes came back intact. It
exits non-zero if anything fails. Run it after changing backup or storage code.
