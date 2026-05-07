# Google Compute Engine Demo Deployment

This file records the successful Google Compute Engine demo deployment for Corolla Fix Helper.

## Deployment Summary

- Deployment status: completed successfully
- Deployment date recorded: May 7, 2026
- Public URL: http://35.222.190.122

## Virtual Machine

- VM name: `corolla-fix-helper-demo`
- OS: Ubuntu 24.04 LTS Minimal
- App runtime: Node 24

## Runtime Setup

- Process manager: systemd
- Reverse proxy: Nginx
- App internal port: `4000`
- Public port: `80`

Plain-English notes:

- systemd keeps the app running as a background service on the VM.
- Nginx receives public web traffic on port `80` and forwards it to the app on port `4000`.
- Port `4000` is the internal app port used by Node.
- Port `80` is the normal public HTTP web port.

## Verified Checks

The following checks passed during the demo deployment:

- `npm run build` passed
- `corolla-fix-helper` systemd service was active/running
- `nginx` service was active/running
- `http://localhost:4000/api/health` worked on the VM
- `http://localhost/api/health` worked through Nginx on the VM
- Public browser URL worked at `http://35.222.190.122`

## Live Data Locations

Real app data for this deployment is stored on the VM at:

```text
/var/corolla-fix-helper/data
/var/corolla-fix-helper/uploads
```

What these folders mean:

- `/var/corolla-fix-helper/data` stores the app database and local data files.
- `/var/corolla-fix-helper/uploads` stores uploaded files, such as repair PDFs.

These folders are important because this app is local-first. If the VM is changed, deleted, or rebuilt, these folders need to be backed up or restored so the real app data is not lost.
