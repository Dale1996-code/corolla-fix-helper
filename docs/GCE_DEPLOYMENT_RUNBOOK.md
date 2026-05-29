# Google Compute Engine Deployment Runbook

This runbook is for a private V1 demo of Corolla Fix Helper on one Google
Compute Engine VM.

This app is currently a non-AI repair document organizer. Keep this deployment
small and local-first:

- React + Vite + Tailwind frontend
- Express backend
- SQLite database file
- local uploaded PDF folder
- Docker container

Do not add AI chat, RAG, embeddings, authentication, Cloud SQL, Cloud Storage,
or multi-vehicle support for this V1 demo path.

## Before You Start

Use sample or fake PDFs for the demo. This app does not have user accounts or
login screens yet, so anything exposed on the VM test port can be viewed by
whoever can reach that port.

Billing warning: Google Cloud can charge money for VMs, disks, snapshots,
network traffic, and Artifact Registry image storage. Read each warning before
running commands that create cloud resources.

Plain-English terms:

- Project: the Google Cloud workspace that owns the VM and Docker repository.
- API: a Google Cloud service switch that must be enabled before you use a
  service.
- Artifact Registry: the private Google Cloud place where your Docker image is
  stored.
- Docker image: the packaged version of the app.
- VM: the virtual computer that runs the app.
- Persistent folder: a folder outside the container that keeps the SQLite
  database and uploaded PDFs when the container is replaced.
- Firewall rule: a rule that decides who can reach a port on the VM.
- Snapshot: a backup copy of a VM disk.

## Command Locations

This runbook labels each command by where to run it:

- Local Windows PowerShell: your computer.
- Google Cloud Shell: the browser terminal inside Google Cloud Console.
- VM SSH: the terminal after you connect into the Compute Engine VM.

For the Google Cloud setup commands, Cloud Shell is usually the easiest place to
work because `gcloud` is already signed in.

## 1) Create Or Select A Google Cloud Project

Billing warning: creating or selecting a project does not usually cost money by
itself, but linking billing and creating resources later can create charges.

Run in Google Cloud Console:

1. Open Google Cloud Console.
2. Use the project selector at the top of the page.
3. Select an existing project, or create a new one.
4. Make sure billing is linked if Google asks for it.

Run in Google Cloud Shell:

```bash
gcloud projects list
gcloud config set project YOUR_PROJECT_ID
gcloud config get-value project
```

Replace `YOUR_PROJECT_ID` with your real project ID, for example
`my-corolla-demo-123`.

## 2) Set Shared Values

Run in Google Cloud Shell:

```bash
PROJECT_ID="$(gcloud config get-value project)"
REGION="us-central1"
ZONE="us-central1-a"
REPO="corolla-fix-helper"
APP="corolla-fix-helper"
VM_NAME="corolla-fix-helper-demo"
TAG="v1-demo-1"
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/$APP:$TAG"

echo "$IMAGE"
```

What this does:

- `PROJECT_ID` uses the project you selected.
- `REGION` is where Artifact Registry stores the image.
- `ZONE` is where the VM runs.
- `REPO` is the Artifact Registry Docker repository name.
- `APP` is the image name.
- `VM_NAME` is the VM name.
- `TAG` is the image version label.
- `IMAGE` is the full Docker image path.

If you close Cloud Shell, run this block again before using later commands.

## 3) Enable Required APIs

Billing warning: enabling these APIs usually does not charge money by itself.
Using the services after they are enabled can create charges.

Run in Google Cloud Shell:

```bash
gcloud services enable compute.googleapis.com artifactregistry.googleapis.com
```

What this enables:

- `compute.googleapis.com`: Compute Engine VMs and disks.
- `artifactregistry.googleapis.com`: private Docker image storage.

## 4) Create The Artifact Registry Docker Repository

Billing warning: Artifact Registry can charge for stored Docker images.

Run in Google Cloud Shell:

```bash
gcloud artifacts repositories create "$REPO" \
  --repository-format=docker \
  --location="$REGION" \
  --description="Corolla Fix Helper Docker images"
```

Verify it:

```bash
gcloud artifacts repositories list --location="$REGION"
```

If Google says the repository already exists, that is okay. Use the existing
repository and continue.

## 5) Build And Push The Docker Image

The repo root already has a multi-stage `Dockerfile`. It builds the Vite client,
keeps the Express server, and runs:

```bash
node server/src/index.js
```

The container listens on port `4000`.

### Option A: Build On Your Local Windows Machine

Use this if Docker Desktop and Google Cloud CLI are installed locally.

Run in Local Windows PowerShell:

```powershell
cd C:\Users\daleb\source\corolla-fix-helper

docker --version
gcloud --version
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud auth configure-docker us-central1-docker.pkg.dev
```

What this does:

- moves into the repo folder
- checks that Docker is installed
- checks that `gcloud` is installed
- signs you in to Google Cloud
- lets Docker push to Artifact Registry

Run in Local Windows PowerShell:

```powershell
$env:PROJECT_ID="YOUR_PROJECT_ID"
$env:REGION="us-central1"
$env:REPO="corolla-fix-helper"
$env:APP="corolla-fix-helper"
$env:TAG="v1-demo-1"
$env:IMAGE="$($env:REGION)-docker.pkg.dev/$($env:PROJECT_ID)/$($env:REPO)/$($env:APP):$($env:TAG)"

docker build -t "$env:IMAGE" .
docker push "$env:IMAGE"
```

Replace `YOUR_PROJECT_ID` with your real project ID.

### Option B: Build In Google Cloud Shell

Use this if the repo is already on GitHub and Cloud Shell can clone it.

Run in Google Cloud Shell:

```bash
git clone YOUR_REPO_URL
cd corolla-fix-helper
git checkout main
gcloud auth configure-docker "$REGION-docker.pkg.dev"
docker build -t "$IMAGE" .
docker push "$IMAGE"
```

Replace `YOUR_REPO_URL` with the repo URL.

### Option C: Build On The VM Later

This is possible, but not the easiest first path. The VM needs Docker, Git, and
permission to write to Artifact Registry. For a beginner demo, prefer Option A
or Option B.

If you intentionally build on the VM, grant the VM service account Writer access
instead of only Reader access:

Run in Google Cloud Shell:

```bash
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)")"
VM_SERVICE_ACCOUNT="$PROJECT_NUMBER-compute@developer.gserviceaccount.com"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$VM_SERVICE_ACCOUNT" \
  --role="roles/artifactregistry.writer"
```

Then, after the VM is created and Docker is installed, run in VM SSH:

```bash
PROJECT_ID="YOUR_PROJECT_ID"
REGION="us-central1"
REPO="corolla-fix-helper"
APP="corolla-fix-helper"
TAG="v1-demo-1"
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/$APP:$TAG"

TOKEN="$(curl -s -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
  | python3 -c "import sys, json; print(json.load(sys.stdin)['access_token'])")"

echo "$TOKEN" | sudo docker login \
  -u oauth2accesstoken \
  --password-stdin "https://$REGION-docker.pkg.dev"

git clone YOUR_REPO_URL
cd corolla-fix-helper
sudo docker build -t "$IMAGE" .
sudo docker push "$IMAGE"
```

## 6) Give The VM Permission To Pull The Image

The VM should be able to read from Artifact Registry so it can pull the Docker
image.

Run in Google Cloud Shell:

```bash
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)")"
VM_SERVICE_ACCOUNT="$PROJECT_NUMBER-compute@developer.gserviceaccount.com"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$VM_SERVICE_ACCOUNT" \
  --role="roles/artifactregistry.reader"
```

What this does:

- finds the default Compute Engine service account
- grants read-only access to Artifact Registry images

## 7) Create The Compute Engine VM

Billing warning: this command creates a running VM and a boot disk. That can
create charges until you stop or delete the VM.

Run in Google Cloud Shell:

```bash
gcloud compute instances create "$VM_NAME" \
  --zone="$ZONE" \
  --machine-type=e2-micro \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=20GB \
  --tags=corolla-fix-helper \
  --scopes=https://www.googleapis.com/auth/cloud-platform
```

What this does:

- creates a small Debian Linux VM
- gives it a 20 GB boot disk
- adds the `corolla-fix-helper` network tag for the firewall rule later
- gives the VM a broad access scope so IAM permissions can work

The `e2-micro` machine type is small. It is fine for a private demo, but Docker
builds may be slow on it. That is why building on your local machine or Cloud
Shell is usually easier.

## 8) Connect To The VM And Install Docker

You do not need to install Node.js on the VM for this Docker path. The Docker
image already contains Node.js 24.

Run in Google Cloud Shell:

```bash
gcloud compute ssh "$VM_NAME" --zone="$ZONE"
```

Now you are in VM SSH.

Run in VM SSH:

```bash
sudo apt-get update
sudo apt-get install -y docker.io curl python3
sudo systemctl enable --now docker
sudo docker --version
```

What this does:

- updates the VM package list
- installs Docker
- installs `curl` and `python3` for one Artifact Registry login helper command
- starts Docker
- makes Docker start again after reboot
- checks Docker is installed

## 9) Create The Persistent Data Folder

Run in VM SSH:

```bash
sudo mkdir -p /opt/corolla-fix-helper-data/uploads
sudo ls -ld /opt/corolla-fix-helper-data /opt/corolla-fix-helper-data/uploads
```

This folder is important.

- The SQLite database file goes here:
  `/opt/corolla-fix-helper-data/corolla-fix-helper.db`
- Uploaded PDFs go here:
  `/opt/corolla-fix-helper-data/uploads`

This folder lives outside the Docker container, so data can survive when the
container is replaced.

## 10) Create The Environment File

Run in VM SSH:

```bash
sudo tee /opt/corolla-fix-helper.env >/dev/null <<'EOF'
DATABASE_FILE=/opt/corolla-fix-helper-data/corolla-fix-helper.db
UPLOADS_DIR=/opt/corolla-fix-helper-data/uploads
MAX_UPLOAD_SIZE_MB=20
PORT=4000
EOF
```

What this does:

- creates a small settings file for the container
- tells the app where the database file lives
- tells the app where uploaded PDFs live
- keeps the upload size limit at 20 MB
- keeps the Express server on port 4000

This file does not contain passwords.

## 11) Log Docker In To Artifact Registry On The VM

Run in VM SSH:

```bash
REGION="us-central1"

TOKEN="$(curl -s -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
  | python3 -c "import sys, json; print(json.load(sys.stdin)['access_token'])")"

echo "$TOKEN" | sudo docker login \
  -u oauth2accesstoken \
  --password-stdin "https://$REGION-docker.pkg.dev"
```

What this does:

- asks the VM metadata service for a short-lived access token
- logs Docker in to Artifact Registry
- avoids creating a long-lived service account key file

The token is temporary. If a future `docker pull` says it is unauthorized, run
this login step again.

## 12) Run The Docker Container With Persistent Storage

Before you run this, make sure `IMAGE` is set in VM SSH.

Run in VM SSH:

```bash
PROJECT_ID="YOUR_PROJECT_ID"
REGION="us-central1"
REPO="corolla-fix-helper"
APP="corolla-fix-helper"
TAG="v1-demo-1"
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/$APP:$TAG"

echo "$IMAGE"
```

Replace `YOUR_PROJECT_ID` with your real project ID.

Run in VM SSH:

```bash
sudo docker pull "$IMAGE"
```

Warning: the next command removes any old container named
`corolla-fix-helper`. It does not delete the database or uploaded PDFs because
those are stored in `/opt/corolla-fix-helper-data`.

Run in VM SSH:

```bash
sudo docker rm -f corolla-fix-helper 2>/dev/null || true

sudo docker run -d \
  --name corolla-fix-helper \
  --restart unless-stopped \
  --env-file /opt/corolla-fix-helper.env \
  -p 4000:4000 \
  -v /opt/corolla-fix-helper-data:/opt/corolla-fix-helper-data \
  "$IMAGE"
```

What this does:

- starts the app in the background
- restarts it after VM reboot unless you manually stop it
- loads the environment values from `/opt/corolla-fix-helper.env`
- maps VM port `4000` to container port `4000`
- mounts the persistent data folder into the container

Check the container:

```bash
sudo docker ps
sudo docker logs --tail=50 corolla-fix-helper
```

## 13) Confirm Restart After Reboot

The restart behavior comes from two settings already used above:

- `sudo systemctl enable --now docker`
- `--restart unless-stopped`

Run in VM SSH:

```bash
sudo docker inspect -f "{{.HostConfig.RestartPolicy.Name}}" corolla-fix-helper
```

Expected output:

```text
unless-stopped
```

Optional reboot test:

Run in VM SSH:

```bash
sudo reboot
```

Wait about one minute, then run in Google Cloud Shell:

```bash
gcloud compute ssh "$VM_NAME" --zone="$ZONE"
```

Run in VM SSH:

```bash
sudo docker ps
curl -i http://localhost:4000/api/health
```

Expected health response includes:

```json
{"status":"ok","message":"Corolla Fix Helper server is running."}
```

## 14) Open Firewall Port 4000 For Testing

Billing and safety warning: opening a firewall port can expose the app to the
internet. For this private demo, restrict access to your own public IP address
when possible.

Run on your Local Windows PowerShell to see your public IP address:

```powershell
curl.exe https://ifconfig.me
```

Copy the IP address.

Run in Google Cloud Shell:

```bash
MY_IP="YOUR_PUBLIC_IP/32"

gcloud compute firewall-rules create allow-corolla-fix-helper-4000 \
  --allow=tcp:4000 \
  --target-tags=corolla-fix-helper \
  --source-ranges="$MY_IP" \
  --description="Temporary private demo access to Corolla Fix Helper"
```

Replace `YOUR_PUBLIC_IP/32` with your public IP plus `/32`, for example:

```text
203.0.113.10/32
```

If the rule already exists and you need to change your IP:

```bash
MY_IP="YOUR_NEW_PUBLIC_IP/32"

gcloud compute firewall-rules update allow-corolla-fix-helper-4000 \
  --source-ranges="$MY_IP"
```

Get the VM public IP:

```bash
EXTERNAL_IP="$(gcloud compute instances describe "$VM_NAME" \
  --zone="$ZONE" \
  --format="value(networkInterfaces[0].accessConfigs[0].natIP)")"

echo "$EXTERNAL_IP"
```

## 15) Smoke Test The App

Smoke test means a quick basic check that the app is alive.

Run in VM SSH:

```bash
curl -i http://localhost:4000/api/health
curl -I http://localhost:4000/
curl -I http://localhost:4000/documents
```

Expected results:

- `/api/health` returns JSON with `"status":"ok"`.
- `/` returns the built frontend.
- `/documents` returns the built frontend route.

Run in your local browser:

```text
http://EXTERNAL_IP:4000/
http://EXTERNAL_IP:4000/documents
http://EXTERNAL_IP:4000/api/health
```

Replace `EXTERNAL_IP` with the VM public IP from the previous step.

Private demo checklist:

- The Dashboard opens.
- Documents opens.
- `/api/health` returns `status: ok`.
- A sample PDF uploads.
- The uploaded sample PDF can be opened.
- After container restart, the document record and PDF are still there.

Restart container test:

Run in VM SSH:

```bash
sudo docker restart corolla-fix-helper
sudo docker ps
```

Then refresh the browser and check the uploaded sample PDF is still listed.

## 16) Optional Nginx And HTTPS Later

Do not do this for the first private port-4000 test. Do it later when you have a
domain name and you want a more normal web URL.

Goal later:

- Nginx listens on ports `80` and `443`.
- Nginx forwards traffic to `http://localhost:4000`.
- Certbot adds an HTTPS certificate.
- The firewall opens only `80` and `443` publicly.
- Port `4000` is closed publicly.

High-level later commands on VM SSH would look like this:

```bash
sudo apt-get install -y nginx
sudo nginx -t
sudo systemctl enable --now nginx
```

Example Nginx site file:

Run in VM SSH:

```bash
sudo tee /etc/nginx/sites-available/corolla-fix-helper >/dev/null <<'EOF'
server {
  listen 80;
  server_name YOUR_DOMAIN;

  location / {
    proxy_pass http://localhost:4000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
EOF

sudo ln -s /etc/nginx/sites-available/corolla-fix-helper /etc/nginx/sites-enabled/corolla-fix-helper
sudo nginx -t
sudo systemctl reload nginx
```

Replace `YOUR_DOMAIN` with your real domain name.

Run in Google Cloud Shell to open normal web ports:

```bash
gcloud compute firewall-rules create allow-corolla-fix-helper-web \
  --allow=tcp:80,tcp:443 \
  --target-tags=corolla-fix-helper \
  --source-ranges=0.0.0.0/0 \
  --description="HTTP and HTTPS access for Corolla Fix Helper"
```

Then run in VM SSH to request HTTPS:

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d YOUR_DOMAIN
```

After HTTPS works, close the temporary public port `4000` rule if you no longer
need it:

Run in Google Cloud Shell:

```bash
gcloud compute firewall-rules delete allow-corolla-fix-helper-4000
```

Do this later because HTTPS setup depends on a real domain name.

## 17) VM Snapshots And Backups

Billing warning: snapshots are backups stored by Google Cloud. They can create
storage charges.

For this V1 demo, the app data is in:

```text
/opt/corolla-fix-helper-data
```

Because that folder is on the VM boot disk, a boot disk snapshot backs up the
database and uploaded PDFs.

This backup step does not move the app database or uploads to Cloud Storage.
The running app still uses the local VM folder.

### Manual Snapshot

For the cleanest backup, stop the app before taking the snapshot.

Run in VM SSH:

```bash
sudo docker stop corolla-fix-helper
```

Run in Google Cloud Shell:

```bash
SNAPSHOT_NAME="corolla-fix-helper-demo-$(date +%Y%m%d-%H%M)"

gcloud compute snapshots create "$SNAPSHOT_NAME" \
  --source-disk="$VM_NAME" \
  --source-disk-zone="$ZONE" \
  --snapshot-type=STANDARD \
  --storage-location="$REGION"
```

Run in VM SSH:

```bash
sudo docker start corolla-fix-helper
```

### Daily Snapshot Schedule

Billing warning: this creates recurring snapshots. Recurring snapshots can keep
creating storage charges until you remove the schedule or delete the snapshots.

Run in Google Cloud Shell:

```bash
SNAPSHOT_POLICY="corolla-fix-helper-daily"

gcloud compute resource-policies create snapshot-schedule "$SNAPSHOT_POLICY" \
  --region="$REGION" \
  --daily-schedule \
  --start-time=08:00 \
  --max-retention-days=7 \
  --on-source-disk-delete=keep-auto-snapshots \
  --storage-location="$REGION"

gcloud compute disks add-resource-policies "$VM_NAME" \
  --zone="$ZONE" \
  --resource-policies="$SNAPSHOT_POLICY"
```

This keeps up to 7 days of scheduled snapshots.

## 18) Restart, Update, And Rollback Commands

Run these in VM SSH.

Show running containers:

```bash
sudo docker ps
```

Show recent app logs:

```bash
sudo docker logs --tail=100 corolla-fix-helper
```

Restart the app:

```bash
sudo docker restart corolla-fix-helper
```

Stop the app:

```bash
sudo docker stop corolla-fix-helper
```

Start the app:

```bash
sudo docker start corolla-fix-helper
```

Update to a new image tag:

```bash
PROJECT_ID="YOUR_PROJECT_ID"
REGION="us-central1"
REPO="corolla-fix-helper"
APP="corolla-fix-helper"
TAG="v1-demo-2"
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/$APP:$TAG"

sudo docker pull "$IMAGE"
sudo docker rm -f corolla-fix-helper

sudo docker run -d \
  --name corolla-fix-helper \
  --restart unless-stopped \
  --env-file /opt/corolla-fix-helper.env \
  -p 4000:4000 \
  -v /opt/corolla-fix-helper-data:/opt/corolla-fix-helper-data \
  "$IMAGE"
```

Rollback to the previous image tag:

```bash
PROJECT_ID="YOUR_PROJECT_ID"
REGION="us-central1"
REPO="corolla-fix-helper"
APP="corolla-fix-helper"
TAG="v1-demo-1"
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/$APP:$TAG"

sudo docker pull "$IMAGE"
sudo docker rm -f corolla-fix-helper

sudo docker run -d \
  --name corolla-fix-helper \
  --restart unless-stopped \
  --env-file /opt/corolla-fix-helper.env \
  -p 4000:4000 \
  -v /opt/corolla-fix-helper-data:/opt/corolla-fix-helper-data \
  "$IMAGE"
```

The rollback commands replace the container, not the persistent data folder.
Your database and uploads remain in:

```text
/opt/corolla-fix-helper-data
```

## 19) Cleanup Commands

Billing warning: cleanup commands can delete cloud resources. Only run these
when you are done with the demo or you are sure you no longer need the resource.

Stop the VM without deleting the disk:

Run in Google Cloud Shell:

```bash
gcloud compute instances stop "$VM_NAME" --zone="$ZONE"
```

Delete the VM and its boot disk:

Run in Google Cloud Shell:

```bash
gcloud compute instances delete "$VM_NAME" --zone="$ZONE"
```

Delete the firewall rule:

Run in Google Cloud Shell:

```bash
gcloud compute firewall-rules delete allow-corolla-fix-helper-4000
```

Delete the Artifact Registry repository:

Run in Google Cloud Shell:

```bash
gcloud artifacts repositories delete "$REPO" --location="$REGION"
```

Before deleting anything, make sure you have a backup if you want to keep the
SQLite database or uploaded PDFs.

## References

- [Google Artifact Registry Docker quickstart](https://cloud.google.com/artifact-registry/docs/docker/store-docker-container-images)
- [Google Artifact Registry Docker authentication](https://cloud.google.com/artifact-registry/docs/docker/authentication)
- [Google Compute Engine VM creation](https://cloud.google.com/compute/docs/instances/create-start-instance)
- [Google Cloud firewall rules](https://cloud.google.com/firewall/docs/using-firewalls)
- [Google Compute Engine snapshots](https://cloud.google.com/compute/docs/disks/create-snapshots)
- [Google Compute Engine snapshot schedules](https://cloud.google.com/compute/docs/disks/scheduled-snapshots)
