# Cost Control

Google Cloud can charge for running VMs, disks, snapshots, stored Docker images, and network traffic.

Use this before and after any deployment test.

## Before Creating Resources

Check the active project:

```bash
gcloud config get-value project
```

List existing VMs:

```bash
gcloud compute instances list
```

List existing Artifact Registry repositories:

```bash
gcloud artifacts repositories list
```

## Stop A VM

Stopping a VM usually stops compute charges, but the disk can still cost money.

```bash
gcloud compute instances stop "$VM_NAME" --zone="$ZONE"
```

## Delete A VM

Warning: this deletes the VM. Depending on Google Cloud options, it may also delete the boot disk.

```bash
gcloud compute instances delete "$VM_NAME" --zone="$ZONE"
```

## Delete A Firewall Rule

```bash
gcloud compute firewall-rules delete allow-corolla-fix-helper-4000
```

## Delete Docker Images Or Repository

List repositories:

```bash
gcloud artifacts repositories list --location="$REGION"
```

Delete the repository only if you no longer need any images in it:

```bash
gcloud artifacts repositories delete "$REPO" --location="$REGION"
```

## Snapshots

Snapshots are disk backups and can cost money while stored.

List snapshots:

```bash
gcloud compute snapshots list
```

Delete an old snapshot:

```bash
gcloud compute snapshots delete SNAPSHOT_NAME
```

Replace `SNAPSHOT_NAME` with the real snapshot name.

## Practical Rule

For short tests:

1. Create the VM only when you are ready to test.
2. Stop the VM when you pause.
3. Delete the VM, firewall rule, images, and snapshots when the demo is no longer needed.
