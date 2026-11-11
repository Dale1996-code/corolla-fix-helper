# Google Cloud Deployment

This is the intended Google Cloud deployment path for the current app. **It has never been run end to end.** Sections 9–13 were rewritten on 2026-11-11: the earlier `docker run` command could not reach the app, and the earlier "external test" opened it on the public internet. The app's own address and Host-name rules behind the new steps were checked on a local machine; the Docker, Google Cloud, and Tailscale steps themselves were not run.

The recommended target is one Google Compute Engine VM running the Docker image from this repo.

## Why Compute Engine

The app currently uses:

- one local SQLite database file
- one local folder for uploaded PDFs

A VM can keep those files on persistent disk. Cloud Run is not the preferred current target unless storage is redesigned.

## Safety Notes

- Google Cloud resources can cost money.
- Use fake or sample PDFs for demos because the app has no login.
- Do not put secrets in the repo.
- **The app has no login, so never give it a public address.** This guide publishes the app only on the VM's own loopback address and reaches it through an SSH tunnel or Tailscale. It opens no firewall port. Do not add one, and do not use `tailscale funnel`.
- This doc gives commands to create resources. Read each section before running it.

## Placeholder Values

Set these in Google Cloud Shell or another terminal with `gcloud` and Docker:

```bash
PROJECT_ID="your-gcp-project-id"
REGION="us-central1"
ZONE="us-central1-a"
REPO="corolla-fix-helper"
IMAGE_NAME="corolla-fix-helper"
TAG="v1"
VM_NAME="corolla-fix-helper-demo"
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/$IMAGE_NAME:$TAG"
```

Replace `your-gcp-project-id` with your real project ID before running cloud commands.

## 1. Select The Project

```bash
gcloud config set project "$PROJECT_ID"
```

This tells `gcloud` which Google Cloud project to use.

## 2. Enable APIs

```bash
gcloud services enable compute.googleapis.com artifactregistry.googleapis.com
```

This enables Compute Engine and Artifact Registry.

## 3. Create Artifact Registry

```bash
gcloud artifacts repositories create "$REPO" \
  --repository-format=docker \
  --location="$REGION" \
  --description="Corolla Fix Helper Docker images"
```

If Google says the repository already exists, use the existing one.

## 4. Build And Push The Docker Image

Run from the repo root:

```bash
gcloud auth configure-docker "$REGION-docker.pkg.dev"
docker build -t "$IMAGE" .
docker push "$IMAGE"
```

This builds the app image and pushes it to Artifact Registry.

## 5. Give The VM Pull Permission

```bash
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)")"
VM_SERVICE_ACCOUNT="$PROJECT_NUMBER-compute@developer.gserviceaccount.com"

gcloud artifacts repositories add-iam-policy-binding "$REPO" \
  --location="$REGION" \
  --member="serviceAccount:$VM_SERVICE_ACCOUNT" \
  --role="roles/artifactregistry.reader"
```

This lets the VM pull the Docker image.

## 6. Create The VM

Billing warning: this creates a running VM and disk.

```bash
gcloud compute instances create "$VM_NAME" \
  --zone="$ZONE" \
  --machine-type=e2-small \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=20GB \
  --scopes=https://www.googleapis.com/auth/cloud-platform \
  --tags=corolla-fix-helper
```

## 7. Install Docker On The VM

Connect:

```bash
gcloud compute ssh "$VM_NAME" --zone="$ZONE"
```

Run on the VM:

```bash
sudo apt-get update
sudo apt-get install -y docker.io
sudo systemctl enable --now docker
```

## 8. Create Persistent Storage

Run on the VM:

```bash
sudo mkdir -p /opt/corolla-fix-helper-data/uploads
sudo chown -R "$USER:$USER" /opt/corolla-fix-helper-data
```

This folder stores the SQLite database and uploaded PDFs outside the container.

## 9. Pull And Run The Container

Set the same image value on the VM:

```bash
REGION="us-central1"
PROJECT_ID="your-gcp-project-id"
REPO="corolla-fix-helper"
IMAGE_NAME="corolla-fix-helper"
TAG="v1"
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/$IMAGE_NAME:$TAG"
```

Log Docker in to Artifact Registry from the VM:

```bash
TOKEN="$(curl -s -H "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")"

echo "$TOKEN" | sudo docker login -u oauth2accesstoken --password-stdin "https://$REGION-docker.pkg.dev"
```

Run the app:

```bash
sudo docker pull "$IMAGE"
sudo docker rm -f corolla-fix-helper || true

sudo docker run -d \
  --name corolla-fix-helper \
  --restart unless-stopped \
  -p 127.0.0.1:4000:4000 \
  -e NODE_ENV=production \
  -e PORT=4000 \
  -e NETWORK_MODE=1 \
  -e ALLOWED_HOSTS= \
  -e DATABASE_FILE=/data/corolla-fix-helper.db \
  -e UPLOADS_DIR=/data/uploads \
  -e MAX_UPLOAD_SIZE_MB=20 \
  -v /opt/corolla-fix-helper-data:/data \
  "$IMAGE"
```

Two settings in this command work as a pair. Change neither on its own:

- **`-e NETWORK_MODE=1`** makes the app listen on all of the *container's* addresses. Without it the app listens only on the container's own loopback address (`server/src/config.js`), so the `-p` mapping can never reach it and every request fails with "connection refused".
- **`-p 127.0.0.1:4000:4000`** publishes that port on the *VM's* loopback address only. Nothing outside the VM can connect, even if a firewall rule is added later. A plain `-p 4000:4000` would listen on every VM address, including the external one.

`ALLOWED_HOSTS` stays empty unless you set up Tailscale (section 11). This command sets no `OPENAI_API_KEY`, so the AI features show "AI not configured". To enable them, add `-e OPENAI_API_KEY=...` here on the VM; never put the key in the repo or the image.

## 10. Smoke Test On The VM

Run on the VM:

```bash
sudo docker ps
curl -i http://localhost:4000/api/health
curl -I http://localhost:4000/
```

Expected result:

- the container is running
- the health route returns `200` with `"status":"ok"`
- the built frontend responds

If `curl` says "connection refused", check that the `docker run` command included `-e NETWORK_MODE=1`.

## 11. Open The App Privately

The app has no login, so it is reached only through a private, encrypted path. Choose one.

**Option A — SSH tunnel (nothing extra to install).** Run this on your own computer, not on the VM, and leave it running:

```bash
gcloud compute ssh "$VM_NAME" --zone="$ZONE" -- -N -L 4000:localhost:4000
```

Then open `http://localhost:4000` in a browser on that same computer. Traffic travels inside the SSH connection, and only people who can SSH into this Google Cloud project can open the tunnel. It only works on a computer with `gcloud` installed, so not on a phone. If port 4000 is already busy on your computer, use `-L 4001:localhost:4000` and open `http://localhost:4001`.

**Option B — Tailscale (works from your phone).** Tailscale gives devices you have signed in to your own Tailscale account a private network, plus an HTTPS address. Run on the VM:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale serve --bg 4000
tailscale serve status
```

`tailscale serve status` prints an address like `https://corolla-fix-helper-demo.tail1234.ts.net`. The app runs inside the container and cannot discover that name by itself, so it refuses requests addressed to it with `421`. Re-run the `docker run` command from section 9, changing one line to that hostname, without `https://`:

```bash
  -e ALLOWED_HOSTS=corolla-fix-helper-demo.tail1234.ts.net \
```

Then open the `https://` address on a device signed in to the same Tailscale account. Serve is private to that account. **Never run `tailscale funnel`**: Funnel publishes the address on the public internet. The first `tailscale serve` may print a link asking you to enable HTTPS for your Tailscale account; follow it. See [Mobile access](mobile-access.md) for why the HTTPS address matters and how to install the app on a phone.

## 12. Backups On The VM

**Settings → Export backup does not work in this setup.** The app only streams a backup to a request that comes from its own machine. Inside the container, every request arrives from Docker's network bridge, not the container's own loopback address, so the download is refused with `403`. (This is a deliberate rule in `server/src/routes/settings.js`, not a bug.)

Back up the data folder on the VM instead. Stopping the container first writes all saved changes into the `.db` file. Run on the VM:

```bash
sudo docker stop corolla-fix-helper
sudo tar -czf ~/corolla-fix-helper-data-$(date +%Y%m%d-%H%M%S).tar.gz -C /opt corolla-fix-helper-data
sudo docker start corolla-fix-helper
```

Then copy it off the VM. Run this on your own computer, replacing the filename with the one created above:

```bash
gcloud compute scp "$VM_NAME":~/corolla-fix-helper-data-YYYYMMDD-HHMMSS.tar.gz . --zone="$ZONE"
```

This archive is a copy of the data folder, not the app's own backup format, so `npm run restore` cannot read it. To restore it, stop the container, replace `/opt/corolla-fix-helper-data` with the archive's contents, and start the container. Neither step has been tested on a VM. See [Backup and restore](backup-restore.md) for what a backup contains.

## 13. Before Relying On It

Before keeping real repair data on the VM:

- make a backup (section 12), restore it into a scratch VM or folder, and check that your documents open
- set a budget alert on the Google Cloud project
- keep the app private: no firewall rule for port 4000, no public address, no `tailscale funnel`

See `docs/cost-control.md` for cleanup commands.
