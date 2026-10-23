# Use It on Your iPhone

How to open Corolla Fix Helper on a phone — over your home Wi-Fi, from anywhere via
Tailscale, and installed on the Home Screen like a real app. Nothing moves to the
cloud: the phone talks directly to the computer running the app, which keeps holding
all your data.

Everything below assumes the **production-style** start (one server on port 4000).

By default the app binds to **localhost only** — nothing off the computer can reach
it, which is the safe default. Phone/LAN/Tailscale access is a deliberate opt-in:
set `NETWORK_MODE=1` so the app listens on all interfaces.

```powershell
npm run build
$env:NETWORK_MODE = "1"; npm start
```

Without `NETWORK_MODE`, the banner reminds you it is localhost-only:

```
Server running on http://localhost:4000
Bound to localhost only. Set NETWORK_MODE=1 to allow phone/LAN/Tailscale access.
```

With `NETWORK_MODE=1`, it prints every address that matters:

```
Server running on http://localhost:4000
On your phone (same Wi-Fi):  http://192.168.1.42:4000
Via Tailscale (anywhere):    http://my-pc.tail1234.ts.net:4000
Install on iPhone from:      https://my-pc.tail1234.ts.net  (HTTPS via tailscale serve)
```

Lines only appear when they apply — no Tailscale means no Tailscale lines. If several
"same Wi-Fi" lines print (virtual adapters on Windows can add extras), try the first
one; it is sorted to be the most likely home-network address.

## Option 1 — Same Wi-Fi (quickest)

1. Start the app in network mode (`npm run build` once after changes, then
   `$env:NETWORK_MODE = "1"; npm start`).
2. On the iPhone, join the **same Wi-Fi network** as the computer.
3. Open Safari and type the banner's "On your phone" address, e.g.
   `http://192.168.1.42:4000`.

That's the whole thing. If it doesn't load, see [Troubleshooting](#troubleshooting).

## Option 2 — From anywhere (Tailscale)

[Tailscale](https://tailscale.com) is a free private network between your own
devices. It is the recommended way to reach the app away from home because nothing
gets exposed to the public internet — only devices signed into **your** Tailscale
account can connect.

One-time setup:

1. Install Tailscale on the computer (tailscale.com/download) and sign in.
2. Install the Tailscale app on the iPhone (App Store) and sign in with the
   **same account**.
3. That's it for basic access: with the iPhone's Tailscale VPN toggle on, the
   banner's "Via Tailscale" address (e.g. `http://my-pc.tail1234.ts.net:4000`)
   works from anywhere — cellular included.

**Recommended extra step — HTTPS via Tailscale Serve.** Run this once on the
computer, in PowerShell:

```powershell
tailscale serve --bg 4000
```

This gives the app a private HTTPS address like `https://my-pc.tail1234.ts.net`
(the startup banner shows it as "Install on iPhone from"). Two reasons to bother:

- **The offline screen needs it.** Browsers only run service workers on HTTPS
  origins, so the friendly "can't reach your workspace" screen (instead of a raw
  Safari error) only works for an app installed from the HTTPS address.
- **One address everywhere.** Install the Home Screen app from this URL and it
  works at home and away without ever re-installing, even if your router hands
  the computer a new LAN IP.

Serve needs network mode too. It relays the phone's request to `localhost:4000`
but keeps the address the phone typed, `my-pc.tail1234.ts.net`, and the app
answers to that name only with `NETWORK_MODE=1`. Under `NETWORK_MODE=0` the
phone gets "This server does not answer to …" (see
[Troubleshooting](#troubleshooting)), which keeps "localhost only" true even with
Serve still running.

Useful commands: `tailscale serve status` shows what's being served;
`tailscale serve reset` turns it off. Serve is **private to your Tailscale
devices** — do not confuse it with `tailscale funnel`, which opens a service to
the public internet and should **not** be used with this app (it has no login).

## Add it to the Home Screen

1. Open the app in **Safari** — use the HTTPS Tailscale Serve address if you set
   it up, otherwise whichever address you use day to day.
2. Tap the **Share** button, then **Add to Home Screen**, then **Add**.
3. Launch **Corolla Fix** from the Home Screen: it opens full-screen with its own
   wrench icon and launch screen — no Safari address bar.

The Home Screen icon is deliberately labelled "Corolla Fix", not "Corolla Fix
Helper": iOS truncates long Home Screen labels, so the app declares that short
form in `apple-mobile-web-app-title` and in the manifest's `short_name`. Those
two fields are the only places the shortened name is used — the browser tab, the
app's own header, and the installed app's manifest `name` all read **Corolla Fix
Helper** in full.

The installed app remembers the address it was installed from, which is why
installing from the Tailscale Serve URL is the "works everywhere" choice.

## Troubleshooting

Work down the list; each step isolates one layer.

1. **Is the server actually up?** On the computer:
   `curl.exe http://localhost:4000/api/health` should return `"status":"ok"`.
2. **Same network?** Phone Wi-Fi and computer must be on the same network (guest
   Wi-Fi networks often isolate devices from each other — use the main network).
3. **Windows firewall.** The first `npm start` should prompt to allow Node.js —
   allow it on **Private networks**. If you dismissed it: Windows Security →
   Firewall & network protection → Allow an app through firewall → check
   Node.js for Private.
4. **Tailscale address fails away from home?** Make sure the Tailscale VPN
   toggle is ON in the iPhone app, and the computer is awake and online (laptops
   asleep serve nothing).
5. **Offline screen shows while everything is running?** That page appears when
   the phone can't reach the computer — tap "Try again" after fixing the
   connection, and check steps 1–4.
6. **Old look after an update?** The app never caches your repair data, so
   nothing can be stale there; if the UI itself looks outdated after you pulled
   new code, close the app fully and reopen it.
7. **"This server does not answer to "…"" (status 421)?** The app answers only
   to names it knows belong to this computer, which is what stops a malicious
   web page from tricking your browser into reaching it (DNS rebinding). Check
   in order:
   - Is the server in network mode? Without `NETWORK_MODE=1` it answers only to
     `localhost`, from the computer itself.
   - Are you using an address the banner printed? Those always work.
   - Using another name, such as `my-pc.local` or a router alias, or the
     MagicDNS name is refused because the `tailscale` CLI isn't on `PATH`? Add
     the name to `ALLOWED_HOSTS` in `server\.env`, for example
     `ALLOWED_HOSTS=my-pc.local`, and restart the server. Hostnames only; ports
     don't matter.
8. **"Refused: this request came from a page on another site" (status 403)?**
   Saving and uploading work only from the app's own pages, so other websites
   can't plant documents or change your data. Open the app at its own address
   (the banner's, or the Home Screen icon) rather than through another site or
   app.

## Security notes, in plain terms

- **Localhost by default.** With no `NETWORK_MODE`, the app is reachable only from
  the computer running it. Turning on `NETWORK_MODE=1` is what opens it to your
  Wi-Fi/Tailscale devices, so exposing the port is always a deliberate act.
- The app has **no login**. Once `NETWORK_MODE=1` is set, anyone who can reach the
  port can read and change your data and spend your OpenAI credit. Same Wi-Fi and
  Tailscale both keep it within networks you control — that is the boundary, so
  only enable network mode on networks where you trust every device.
- **Never port-forward** port 4000 on your router and never use
  `tailscale funnel` with this app; both would put it on the public internet.
- **Other web pages can't drive it.** No login doesn't mean any website can
  use it. The app answers only to this computer's own names, which blocks DNS
  rebinding, and it accepts a save, upload or delete from a browser only when it
  comes from its own pages (status 403 otherwise). So a page you happen to have open elsewhere can't
  plant a fake "factory manual" or change your data. This protects against web
  pages, not against devices: anything on your Wi-Fi or tailnet that can reach
  the port can still use the app directly.
- **Backups download from the host only.** The Settings backup export
  (`/api/settings/backup-export`) streams your entire database and uploads, so it
  is restricted to the computer itself and returns 403 from any other device,
  even in network mode and through `tailscale serve`: Serve relays the phone
  from `localhost`, so the app also refuses any request carrying a proxy's
  forwarding headers or addressed to a network name. Pull backups on the
  computer that runs the app, at `http://localhost:4000`.
- The AI rate limit is a spend cap, not authentication: 20 requests a minute per client address, shared by Ask, the Repair Planner, and suggested procedures. Phones relayed through `tailscale serve` all reach the app from `localhost`, so they share one window.
