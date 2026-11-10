# Backup and restore

Corolla Fix Helper keeps everything local: one SQLite database file
(`DATABASE_FILE`, default `server/data/corolla-fix-helper.db`) and one uploads
folder of uploaded PDFs and saved attachment images (`UPLOADS_DIR`, default
`server/uploads/`). A backup captures
both, and restore puts both back. An export you cannot restore is not a real
backup, so the two halves are documented together here.

## What a backup contains

A backup is a single gzipped tar archive named
`corolla-fix-helper-backup-<timestamp>.tar.gz`, whether it comes from the
Settings download or from `npm run backup`. The archive's root holds:

```
database/<name>.db   a snapshot of the SQLite database, including the newest
                     saved changes
uploads/...          a copy of the whole uploads folder: every uploaded PDF
                     and attachment image
manifest.json        format version, app name, creation time, and database
                     file name. Only the command-line export and the drill
                     write it. The Settings download leaves it out, and
                     restore accepts archives with or without it.
```

A backup does not include `server/.env`, which holds your OpenAI key and other
settings. If you would need that file on a new computer, keep a copy of it
yourself.

## Export a backup

You can produce a backup two ways:

- **From the app:** open **Settings → Export backup** and download the
  `.tar.gz`. This streams the database and uploads straight to your browser.
  It only works in a browser on the computer that runs the app, at a
  `localhost` address. From a phone or another device (including through
  Tailscale) the download is refused with "Backups can only be downloaded on
  the host machine itself…".
- **From the command line** (handy for scripts and scheduled tasks):

  ```bash
  npm run backup -- "D:\Backups"
  ```

  Run it from the project root, with the folder you want the archive written to.
  The folder is required, and is created if it does not exist. It is safe to run
  while the app is running: the database is read through SQLite, which includes
  everything saved so far. It reads `server/.env` the same way the app does, so a
  `DATABASE_FILE` or `UPLOADS_DIR` set there is picked up.

  By default it also **test-restores the new archive**: it unpacks the archive
  into a scratch folder and runs the same checks a real restore runs (the database
  must open, pass SQLite's integrity check, and contain this app's tables). It
  removes the scratch folder afterwards and touches none of your live data. Add
  `--no-verify` to skip that step; the backup is then recorded as created but not
  verified.

  It is built so that it cannot damage a backup you already have:

  - It **never overwrites or deletes an existing file**. If a file with the
    archive's name is already there, it stops.
  - The archive is written as `<name>.tar.gz.partial` and renamed only once it is
    complete (and, unless `--no-verify`, once the test restore passed). A
    `.tar.gz` in your folder is therefore never half-written. If a run fails, it
    removes only the `.partial` file it created.
  - It refuses a folder inside your uploads folder, because every backup would
    then contain the one before it.
  - A failed run leaves the "Last backup" record (below) exactly as it was.

Store the resulting file somewhere off the machine (another disk, a synced
folder, etc.). A backup on the same disk as the app does not protect you from
that disk failing. Use sample or fake PDFs before sharing a backup.

## Last backup in Settings

**Settings → Backup and restore → Last backup** shows when the most recent
successful backup was made, where it was saved, and whether the app can still
stand behind it.

Where the note is kept matters. It lives in a small file,
`backup-status.json`, **in the same folder as the database** (`server/data/` by
default). It is deliberately not a database table and not inside the uploads
folder. A restore swaps the database file and the uploads folder and nothing
else, and the file is never part of an archive, so restoring an older backup
cannot rewind it into reporting a backup that never happened. Delete the file
and Settings simply says no backup is recorded.

It holds one record, the most recent successful backup. A backup counts only
when it actually completed:

| Made with | Recorded when | Destination | Test restore |
|---|---|---|---|
| `npm run backup` | the archive is complete and, unless `--no-verify`, the test restore passed | the full path | `passed`, or `not run` with `--no-verify` |
| Settings → Export backup | the whole archive has been sent to the browser; a failed or cancelled download is never recorded | **unknown**: the browser decides where the file goes | never run |

What Settings shows is re-checked each time the page loads (or when you press
**Check again**), not copied from the note. The headline is one of three:

- **Verified**: the archive is still at its recorded location with the size it
  had, **and** it passed a test restore.
- **Created, not verified**: the file is there, but no test restore was run on it
  (`--no-verify`).
- **Status unknown**: the file is missing or its size has changed, or the app
  cannot see where it went. Every Settings download lands here by design, because
  the app cannot find a file your browser saved or test-restore it. If the file
  was moved on purpose, this is expected.

Settings never calls a backup "safe". "File found" means a file of the recorded
size exists, not that its contents were re-read. Only a test restore reads the
archive, and only at the moment `npm run backup` made it.

A backup **older than 7 days**, or no recorded backup at all, shows an amber
warning. Backups made before this note existed, or saved some other way (such as
copying files by hand), are not counted. A Settings download finishes after you
click, so press **Check again** once it is done.

There is not yet a command that test-restores a backup file you already have.
`npm run restore` is the real thing and replaces your live data, so do not use it
as a check. For a verified backup, use `npm run backup`.

## If `npm run backup` fails

The command exits non-zero and prints `Backup failed: …`, then confirms that no
existing file was changed and the last-backup record was not updated. Common
messages:

- **`Usage: npm run backup -- "<folder>" [--no-verify]`**: you left out the
  folder, gave more than one, or typed an option it does not know. Nothing was
  done.
- **`… already exists, so nothing was written`**: a file with that exact name is
  already in the folder (names carry the time to the millisecond, so this is
  rare). Nothing was overwritten. Run the command again.
- **`… is inside your uploads folder`**: pick a folder outside `UPLOADS_DIR`.
- **`Backup database is missing required tables …`, an integrity-check message,
  or `tar exited with code …`**: the archive was made but did not pass the test
  restore (or could not be made), so it was removed and **nothing was recorded**.
  Check free disk space and run it again. If it keeps failing on the integrity
  check, your live database may be damaged: stop the app and look at it before
  doing anything else.
- **`The backup was made, but the "last backup" note could not be saved`**: the
  archive is complete and was kept. Only the Settings note failed, usually
  because the folder holding the database is not writable. Settings will not show
  this backup until a later backup records one.
- **`tar is not available on this system`**: Windows 10 and later ship `tar`; on
  other systems install it.

## Restore a backup

Restore is **CLI-only**. There is no restore button in the app, and adding one
is not planned: restoring replaces the live database while the server holds it
open, so it has to happen with the server stopped. Settings shows these same
instructions next to the export button so the two halves are discoverable
together.

> **Stop the server first, and keep it stopped until the restore finishes.**
> Restarting it afterward is not a substitute. The running app keeps the
> database file open, and restore moves that file aside. On Windows the move is
> refused and the restore rolls back. On macOS/Linux the move succeeds, and
> anything the still-running server writes afterward goes into the moved-aside
> previous database, not the restored one, so it is missing once the app
> restarts.

Run the restore CLI with the path to a backup archive:

```bash
npm run restore -- "/path/to/corolla-fix-helper-backup-2026-06-15T....tar.gz"
```

Run it from the project root. **Use the full path to the archive, in quotes.**
A relative path is resolved from the `server` folder, not from the folder you
typed the command in, because the root script hands the command to `server/`.
For example, `npm run restore -- "backups/my-backup.tar.gz"` typed in the
project root looks for `server/backups/my-backup.tar.gz`. The archive itself can
sit anywhere.

The command uses only the first argument and **starts immediately; there is no
confirmation prompt**. A successful restore replaces the whole database, so
everything saved in the app is replaced with what is in the archive: documents,
symptoms, procedures, notes, repair checklists, repair history, settings, and
uploaded files. You do not need to take a safety backup by hand. Step 4 below
keeps your current data for you.

Restore targets the same `DATABASE_FILE` / `UPLOADS_DIR` the app uses. It reads
`server/.env` the same way the app does, so values set there are picked up
automatically. If you set them in your terminal instead, set them the same way
before restoring.

What it does, in order:

1. **Extract** the archive into a temporary working directory.
2. **Validate** it. The archive must contain a `database/` folder with exactly
   one database file, and an `uploads/` folder. The database must open in
   SQLite, pass SQLite's built-in integrity check (`PRAGMA quick_check`), and
   contain this app's `documents`, `symptoms`, and `procedures` tables. A
   `manifest.json`, if present, must be valid JSON and must not come from a
   newer backup format than this app supports. A bad or incompatible archive is
   rejected here, before your data is touched.
3. **Copy** the validated database and uploads beside the live ones, as
   `<DATABASE_FILE>.restore-<timestamp>` and `<UPLOADS_DIR>.restore-<timestamp>`.
   Only new paths are written, so a failure here (a full disk, say) changes
   nothing.
4. **Swap** using renames only, uploads first:
   - The live uploads folder is renamed to
     `<UPLOADS_DIR>.pre-restore-<timestamp>` beside it, and the restored uploads
     copy from step 3 takes its place. Uploads go first because on Windows, a
     PDF open in another program makes that rename fail before anything has
     moved.
   - The live database, together with any `-wal`, `-shm`, or `-journal` files
     beside it (after an unclean stop the newest rows can live only in the
     `-wal`), moves into a `pre-restore-<timestamp>/database/` folder next to
     the database file. The restored database copy then takes its place.

With the default paths, your previous data ends up here:

```
server/data/pre-restore-<timestamp>/database/corolla-fix-helper.db   previous database
server/uploads.pre-restore-<timestamp>/                              previous uploads
```

`<timestamp>` looks like `2026-06-15T14-30-05-123Z`. It is in UTC, so it may not
match your clock, and it is the same in every name from one restore.

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
  renaming. A rollback never deletes or overwrites any of your data either. It
  only cleans up its own copies of the backup. Whatever it cannot move back
  stays where it is, and the CLI tells you where.

## If a restore fails

The CLI exits non-zero. Its first line, `Restore failed: …`, gives the reason,
for example `Backup archive not found: …` or `Backup database failed its
integrity check: …`. The next line says which of three things happened:

- **"Nothing was changed"**: the restore stopped before moving anything, and
  your database and uploads are exactly as they were. Common causes are a wrong
  path (relative paths start from `server/`), a file that is not a Corolla Fix
  Helper backup or is damaged, or not enough disk space for the copy. If the CLI
  adds **"A file was locked or in use"** (usual on Windows), stop the app, close
  any program that has one of your uploaded PDFs or the database open, and run
  the restore again.
- **"The restore was rolled back"**: something had been moved, and all of it was
  moved back. None of your data was deleted and the app is unchanged. The usual
  cause is the app still running on Windows, which blocks moving the database.
  Stop the app and run the restore again. The "A file was locked or in use" hint
  may appear here too.
- **"The rollback also failed"**: something could not be moved back. Nothing was
  deleted. The CLI lists where your previous database and uploads now are,
  followed by numbered steps (rename the restored copy out of the way, then move
  each original back). Stop the app and follow them. Do not delete any
  `pre-restore` folder until the app shows your data again.

Two other messages can appear:

- **`Usage: npm run restore -- "/path/to/…"`**: you left out the archive path.
  Nothing was changed. Run the command again with the path.
- **"The restore could not tell whether your data was changed"**: a safety net
  for an unexpected error. Stop the app and, before doing anything else, check
  the two folders it names for `pre-restore-<timestamp>` and
  `uploads.pre-restore-<timestamp>` folders. If they exist, your previous data
  is in them.

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
procedures, notes, a PDF, and an attachment image; exports a backup while a
database connection is still open, the way the running app's would be; wipes
the database and uploads; restores; and asserts the row counts and the PDF and
image bytes came back intact. It uses the same export code as `npm run backup`,
not the Settings download. It does not touch the last-backup note. It prints `Backup + restore drill PASSED` on success
and exits non-zero if anything fails. Run it after changing backup or storage
code.
