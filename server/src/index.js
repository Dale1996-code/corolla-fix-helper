import { config } from "./config.js";
import { createApp } from "./app.js";
import { describePhoneAccessUrls } from "./services/networkAddresses.js";

const app = createApp();

app.listen(config.port, () => {
  console.log(`Server running on http://localhost:${config.port}`);

  describePhoneAccessUrls(config.port).then((lines) => {
    for (const line of lines) {
      console.log(line);
    }
  });
});
