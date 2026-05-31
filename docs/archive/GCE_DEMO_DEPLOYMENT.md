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
- systemd service name: `corolla-fix-helper`
- Docker/container runtime: not used by the currently documented deployment

Plain-English notes:

- systemd keeps the app running as a background service on the VM.
- Nginx receives public web traffic on port `80` and forwards it to the app on port `4000`.
- Port `4000` is the internal app port used by Node.
- Port `80` is the normal public HTTP web port.
- Nginx Basic Auth is enabled. Do not save the actual password in this repo or in deployment notes.
- This deployment is still plain HTTP. Until HTTPS is added, Basic Auth credentials are sent over an unencrypted connection.

## Verified Checks

The following checks passed during the demo deployment:

- `npm run build` passed
- `corolla-fix-helper` systemd service was active/running
- `nginx` service was active/running
- `http://localhost:4000/api/health` worked on the VM
- `http://localhost/api/health` worked through Nginx on the VM
- Public browser URL worked at `http://35.222.190.122`

## Live Data Locations

Real app data for this deployment is stored on the VM at these paths, confirmed by the live `/api/settings` response on May 7, 2026:

```text
/var/corolla-fix-helper/data/corolla-fix-helper.db
/var/corolla-fix-helper/uploads
```

What these folders mean:

- `/var/corolla-fix-helper/data/corolla-fix-helper.db` is the SQLite database file.
- `/var/corolla-fix-helper/uploads` stores uploaded files, such as repair PDFs.

These folders are important because this app is local-first. If the VM is changed, deleted, or rebuilt, these folders need to be backed up or restored so the real app data is not lost.

## Recovery Commands

Run these commands from an SSH session on the VM:

```bash
sudo systemctl status corolla-fix-helper --no-pager
sudo systemctl restart corolla-fix-helper
sudo systemctl status nginx --no-pager
sudo systemctl reload nginx
```

Use these checks after a restart:

```bash
curl http://localhost:4000/api/health
curl http://localhost/api/health
```

## Details Still Needing VM Shell Confirmation

The public app and API can be checked from another computer, but these details need VM shell access to verify exactly:

- app code location on the VM: check `sudo systemctl cat corolla-fix-helper` and look for `WorkingDirectory=`
- Nginx config file location: check `sudo nginx -T` or list `/etc/nginx/sites-enabled`

## Backup And Export Status

The live `/api/settings` response on May 7, 2026 reported backup/export as supported and described an export backup as one `.tar.gz` file containing the SQLite database and uploaded PDFs.
