import { config } from "./config.js";
import { createApp } from "./app.js";
import { describePhoneAccessUrls } from "./services/networkAddresses.js";

const app = createApp();

app.listen(config.port, config.host, () => {
  console.log(`Server running on http://localhost:${config.port}`);

  // Phone/LAN URLs are only reachable (and only printed) in network mode. In the
  // default loopback mode, point the user at the deliberate opt-in instead of
  // printing addresses that nothing off-host can reach.
  if (config.networkMode) {
    describePhoneAccessUrls(config.port).then((lines) => {
      for (const line of lines) {
        console.log(line);
      }
    });
  } else {
    console.log(
      "Bound to localhost only. Set NETWORK_MODE=1 to allow phone/LAN/Tailscale access."
    );
  }
});
