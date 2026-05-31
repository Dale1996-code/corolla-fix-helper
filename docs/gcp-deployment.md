# Google Cloud Deployment

This is the intended Google Cloud deployment path for the current app. It has not been run or verified as part of this documentation cleanup.

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
- Do not expose the app publicly without access control and HTTPS.
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
  -p 4000:4000 \
  -e NODE_ENV=production \
  -e PORT=4000 \
  -e DATABASE_FILE=/data/corolla-fix-helper.db \
  -e UPLOADS_DIR=/data/uploads \
  -e MAX_UPLOAD_SIZE_MB=20 \
  -v /opt/corolla-fix-helper-data:/data \
  "$IMAGE"
```

## 10. Smoke Test On The VM

Run on the VM:

```bash
sudo docker ps
curl -i http://localhost:4000/api/health
curl -I http://localhost:4000/
```

Expected result:

- the container is running
- the health route returns OK
- the built frontend responds

## 11. Temporary External Test

Only open a public firewall rule if you understand the risk. Prefer restricting it to your own IP.

```bash
gcloud compute firewall-rules create allow-corolla-fix-helper-4000 \
  --allow=tcp:4000 \
  --target-tags=corolla-fix-helper \
  --source-ranges=YOUR_PUBLIC_IP/32
```

Replace `YOUR_PUBLIC_IP/32` with your current public IP range.

Get the VM public IP:

```bash
gcloud compute instances describe "$VM_NAME" \
  --zone="$ZONE" \
  --format="value(networkInterfaces[0].accessConfigs[0].natIP)"
```

Then open:

```text
http://VM_PUBLIC_IP:4000
```

## 12. Before Sharing More Broadly

Before sharing a public URL, add:

- HTTPS
- access control
- backup plan
- restore test
- cost controls

See `docs/cost-control.md` for cleanup commands.
