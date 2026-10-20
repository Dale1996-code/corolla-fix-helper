import { config } from "./config.js";
import { createApp } from "./app.js";
import { closeDatabase } from "./database.js";
import { describePhoneAccessUrls } from "./services/networkAddresses.js";
import { startServer } from "./serverLifecycle.js";

startServer({
  app: createApp(),
  port: config.port,
  host: config.host,
  // Ctrl+C, a closed console window, or SIGTERM checkpoints the WAL into the
  // .db file and closes it, so the .db file alone holds every committed row.
  closeDatabase,
  onListening(server) {
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : config.port;

    console.log(`Server running on http://localhost:${port}`);

    // Phone/LAN URLs are only reachable (and only printed) in network mode. In
    // the default loopback mode, point the user at the deliberate opt-in
    // instead of printing addresses that nothing off-host can reach.
    if (config.networkMode) {
      describePhoneAccessUrls(port).then((lines) => {
        for (const line of lines) {
          console.log(line);
        }
      });
    } else {
      console.log(
        "Bound to localhost only. Set NETWORK_MODE=1 to allow phone/LAN/Tailscale access."
      );
    }
  },
});
