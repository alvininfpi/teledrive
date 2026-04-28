import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import input from "input"; // you might need to install this or use a simple readline

/**
 * RUN THIS LOCALLY to get your string session.
 * node generate_session.js
 */

const apiId = 0; // FILL THIS
const apiHash = ""; // FILL THIS

(async () => {
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.start({
    phoneNumber: async () => await input.text("Please enter your number: "),
    password: async () => await input.text("Please enter your password: "),
    phoneCode: async () =>
      await input.text("Please enter the code you received: "),
    onError: (err) => console.log(err),
  });
  console.log("Your string session is:", client.session.save()); 
  await client.disconnect();
})();
