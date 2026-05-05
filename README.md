# Corolla Fix Helper

Corolla Fix Helper is a local-first repair helper for one vehicle:

- 2009 Toyota Corolla LE 1.8L

It runs on your computer, stores data in a local SQLite database, and keeps uploaded PDF files in a local folder. The goal is to help you keep repair information, symptoms, procedures, and notes in one place while working on the car.

## Current v1 scope

Version 1 currently includes these main areas:

- Dashboard
- Documents
- Search
- Symptoms
- Procedures
- Notes
- Settings

Version 1 is still limited in a few important ways:

- Single vehicle only
- Local-first only
- No cloud sync
- No user accounts
- No AI chat

## What the app does right now

### Dashboard

The Dashboard gives a quick summary of the current project. It shows counts and recent activity for:

- documents
- symptoms
- procedures
- notes
- favorites

It also gives quick links into the main parts of the app.

### Documents

The Documents area covers the main document workflow. Some end-to-end
flows are still being stabilized; the area should be considered fully
working only once `npm run test` is consistently green.

What it can do:

- upload PDF files
- save uploaded PDFs into `server/uploads`
- store document details in SQLite
- try to extract text from PDFs
- manually re-run extraction for a single document from the detail panel
- store extraction status
- store page count
- edit document metadata after upload
- mark documents as favorites
- open an uploaded PDF from the app
- delete a document with a confirmation prompt
- when deleting, remove linked symptom/procedure links, clear linked note references, and remove the stored PDF file safely
- use saved Settings suggestions while entering system and document type
- sort and filter the document list
- show document details in a side panel

For V1, favorites are the only saved-document flag in the app.
Tags and bookmarks are not part of the current document workflow.

Document fields currently used in the app include:

- title
- system
- subsystem
- document type
- source
- notes

### Search

The Search page is implemented.

It gives you four separate search sections on one page:

- documents
- symptoms
- procedures
- notes

Each section keeps its own keyword box, filters, and results so you can search one area without changing the others.

### Symptoms

The Symptoms feature is implemented.

What it can do:

- create symptoms
- edit symptoms
- delete symptoms
- store status and confidence
- link symptoms to documents
- show linked documents in the symptom details
- search symptoms by title, system, suspected causes, and notes
- filter symptoms by status and system
- sort symptoms by newest update, oldest update, or title
- show summary counts for open, monitoring, and resolved symptoms

### Procedures

The Procedures feature is implemented.

What it can do:

- create procedures
- edit procedures
- delete procedures
- store steps, tools, parts, safety notes, difficulty, and confidence
- link procedures to documents
- show linked documents in the procedure details and open them from there
- reuse saved Settings system suggestions while entering the system field in create and edit forms
- search procedures by title, system, tools, parts, steps, and notes
- filter procedures by system, difficulty, and confidence
- sort procedures by newest update, oldest update, or title
- show a visible "Showing X of Y procedures" count while browsing
- keep the detail panel focused on a visible procedure when filters change

### Notes

The Notes feature is implemented.

What it can do:

- create notes
- edit notes
- delete notes
- organize notes by note type
- link notes to a document, symptom, or procedure in the current UI
- browse saved notes with note type, linked item, and sort controls
- show a visible "Showing X of Y notes" count while browsing
- open the linked document, symptom, or procedure from the note details panel

### Settings

The Settings page is implemented.

What it can do:

- edit the single stored vehicle profile
- save reusable document defaults for common system names and document types
- show the local database path
- show the local uploads folder
- show the upload size limit
- show the frontend and backend ports
- export a local backup archive (.tar.gz) that includes the database and uploaded PDFs

The runtime path values are read-only in the browser. They come from local config and optional `.env` values.
Settings now includes a manual **Export backup (.tar.gz)** action. It downloads one archive that contains the SQLite database and all uploaded PDFs so you can store a local backup copy on your computer. Restore is not included in this phase.

## Tech stack

- `client`: React + Vite + Tailwind CSS
- `server`: Node.js + Express
- `database`: SQLite
- `file storage`: local `server/uploads` folder

## Project structure

```text
corolla-fix-helper/
  client/   Frontend app
  server/   API, database setup, and file storage
```

## First-time setup

Open a terminal in the project folder, then run:

```bash
npm run install:all
```

What this does:

- installs the root package used to run the client and server together
- installs server packages
- installs client packages

## Run the app

```bash
npm run dev
```

After that:

- frontend: `http://localhost:5173`
- backend: `http://localhost:4000`
- health check: `http://localhost:4000/api/health`

## Useful commands

Run only the server:

```bash
npm run dev:server
```

Run only the client:

```bash
npm run dev:client
```

Build the client:

```bash
npm run build
```

Run both test suites:

```bash
npm run test
```

Run only the backend tests:

```bash
npm run test:server
```

Run only the frontend tests:

```bash
npm run test:client
```

Start the app with the built client:

```bash
npm start
```

Manual QA checklist:

- `QA_CHECKLIST.md`

## Environment values

Copy `.env.example` to `.env` if you want your own local settings.

Important values:

- `PORT=4000` sets the Express server port
- `CLIENT_PORT=5173` sets the Vite dev server port
- `DATABASE_FILE=./server/data/corolla-fix-helper.db` sets the SQLite database file path
- `UPLOADS_DIR=./server/uploads` sets where uploaded PDFs are stored
- `MAX_UPLOAD_SIZE_MB=20` sets the PDF upload size limit
- `NODE_ENV=production` switches the server into production mode (serves the built client)
- `CORS_ORIGIN=http://localhost:5173` sets the allowed CORS origin for the API

## Deploying to GCP (GCE + systemd)

The production target is a single **e2-small** Compute Engine VM running
Debian 12, with a 20 GB pd-balanced data disk mounted at `/var/lib/corolla`.
Docker runs the image, and a **systemd unit** manages the process lifecycle.
**Caddy** sits in front as a reverse proxy and terminates TLS.

> **Before you upload any real repair documents**, complete the full backup
> drill described at the end of this section. An untested backup is not a
> backup.

---

### 1. Provision the VM and data disk

```bash
# Create the data disk (one-time)
gcloud compute disks create corolla-data \
  --size=20GB --type=pd-balanced --zone=us-central1-a

# Create the VM and attach the disk
gcloud compute instances create corolla-vm \
  --machine-type=e2-small \
  --zone=us-central1-a \
  --image-family=debian-12 --image-project=debian-cloud \
  --disk=name=corolla-data,device-name=corolla-data,auto-delete=no \
  --scopes=cloud-platform \
  --service-account=<sa-with-artifactregistry-reader>@<project>.iam.gserviceaccount.com
```

SSH in, then:

```bash
# Format and mount the data disk (one-time — skip on re-deploy)
sudo mkfs.ext4 -F /dev/disk/by-id/google-corolla-data
sudo mkdir -p /var/lib/corolla/uploads
echo '/dev/disk/by-id/google-corolla-data /var/lib/corolla ext4 defaults,nofail 0 2' | \
  sudo tee -a /etc/fstab
sudo mount -a

# The container runs as UID 1000 (the node user inside the image).
# The host's first non-root user is usually also UID 1000; check with:
#   id -u $(whoami)
# If it matches, reuse it. Otherwise create a dedicated user:
#   sudo useradd -u 1000 -M -s /usr/sbin/nologin corolla
sudo chown -R 1000:1000 /var/lib/corolla
```

---

### 2. Install Docker and Caddy

```bash
# Docker
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable docker

# Caddy
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | \
  sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | \
  sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install caddy
```

---

### 3. Authenticate Docker to Artifact Registry

```bash
gcloud auth configure-docker us-central1-docker.pkg.dev
```

The VM's service account needs the `roles/artifactregistry.reader` IAM role on
your Artifact Registry repository.

---

### 4. Build and push the image

From your development machine:

```bash
IMAGE=us-central1-docker.pkg.dev/<project>/apps/corolla-fix-helper:<git-sha>
docker build -t "$IMAGE" .
docker push "$IMAGE"
```

---

### 5. Configure the app environment

```bash
# On the VM — create /etc/corolla.env (chmod 600 it after)
sudo tee /etc/corolla.env > /dev/null << EOF
NODE_ENV=production
CORS_ORIGIN=https://yourdomain.example.com
DATABASE_FILE=/var/lib/corolla/corolla-fix-helper.db
UPLOADS_DIR=/var/lib/corolla/uploads
MAX_UPLOAD_SIZE_MB=20
COROLLA_IMAGE=us-central1-docker.pkg.dev/<project>/apps/corolla-fix-helper:<git-sha>
GCS_BUCKET=<your-backup-bucket>
EOF
sudo chmod 600 /etc/corolla.env
```

---

### 6. Install the systemd unit

```bash
sudo cp deploy/systemd/corolla.service /etc/systemd/system/corolla.service
sudo systemctl daemon-reload
sudo systemctl enable corolla
sudo systemctl start corolla

# Verify
systemctl status corolla
curl http://127.0.0.1:4000/api/health
```

---

### 7. Configure Caddy

```bash
# Set basic-auth credentials (see deploy/caddy/Caddyfile for IAP alternative)
HASH=$(caddy hash-password)   # enter your password when prompted
sudo tee -a /etc/systemd/system/caddy.service.d/env.conf << EOF
[Service]
Environment=CADDY_ADMIN_USER=admin
Environment=CADDY_ADMIN_HASH=${HASH}
EOF
sudo systemctl daemon-reload

sudo cp deploy/caddy/Caddyfile /etc/caddy/Caddyfile
# Edit /etc/caddy/Caddyfile — replace yourdomain.example.com with your hostname
sudo systemctl restart caddy
```

Open a browser and visit `https://yourdomain.example.com`. Log in with the
password you set above.

#### Access-control trade-offs

| Option | What it actually means |
|---|---|
| **Basic auth via Caddy** (default) | Password-protected public URL. The hostname is enumerable in cert-transparency logs; brute-forceable without rate limiting; one leaked password exposes everything. Fine as a starting point. |
| **GCP Identity-Aware Proxy** | A GCE HTTPS Load Balancer + IAP sits in front. Unauthenticated requests are rejected before reaching the VM. Identity is your Google account. More setup (LB, backend service, OAuth consent screen) but genuinely private. |

Start with basic auth, graduate to IAP once the rest of the deploy is stable.
Document whichever you choose as a deliberate trade-off, not a finished story.

#### HEALTHCHECK caveat

The `HEALTHCHECK` in the Dockerfile changes the container's reported status
(`docker inspect --format '{{.State.Health.Status}}'`), but **it does not
restart anything by itself**. Recovery comes from three separate mechanisms:

1. `Restart=always` in the systemd unit — restarts on process exit/crash.
2. An external uptime check (GCP Monitoring uptime check or Cloudflare) that
   pages when `/api/health` goes red — that's how you find out about
   *"unhealthy but still running"* cases.
3. Optional: a systemd timer (`/etc/systemd/system/corolla-autoheal.timer`)
   that polls `docker inspect` and runs `docker restart corolla` when the
   status is `unhealthy`. Useful but opt-in — don't add it until the deploy
   is otherwise stable.

---

### 8. Backup and restore drill (required before real data)

Configure a lifecycle policy on your GCS bucket first:
- 14 daily copies (delete after 14 days)
- 12 monthly copies (move to Nearline after 30 days)

Run a manual backup to confirm it works:

```bash
# On the VM
GCS_BUCKET=<your-backup-bucket> bash deploy/scripts/backup.sh
```

Schedule daily backups via a systemd timer (add to `/etc/systemd/system/`):

```ini
# corolla-backup.timer
[Unit]
Description=Daily Corolla Fix Helper backup

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
```

```ini
# corolla-backup.service
[Unit]
Description=Corolla Fix Helper backup

[Service]
Type=oneshot
EnvironmentFile=/etc/corolla.env
ExecStart=/bin/bash /opt/corolla/deploy/scripts/backup.sh
```

#### Restore drill (gating step — do this on a scratch VM first)

1. On a **scratch VM** (not production), provision a fresh data disk and start
   the service with an empty database.
2. Run the restore script pointing at a recent snapshot:
   ```bash
   sudo GCS_BUCKET=<bucket> bash deploy/scripts/restore.sh \
     gs://<bucket>/daily/<timestamp>.tar.gz
   ```
3. Confirm the service came back up:
   ```bash
   curl http://127.0.0.1:4000/api/health
   # should return {"status":"ok",...}
   ```
4. Log into the app and verify documents, symptoms, procedures, and notes are
   all intact.

Only after this drill passes on the scratch VM should the production VM be used
for real repair documents.

---

### 9. Verify the full stack

```bash
# After a reboot — data must survive
sudo reboot
# ... wait for VM to come back up ...
systemctl status corolla
curl https://yourdomain.example.com/api/health

# Graceful shutdown test
sudo systemctl stop corolla
# Check the service log shows the "Graceful shutdown" and "Database closed" lines
journalctl -u corolla --no-pager | tail -20
```
