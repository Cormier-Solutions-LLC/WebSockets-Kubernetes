"use strict";

const status = document.querySelector("#status");
const client = new CormierRealtime.RealtimeClient({
  url: "/realtime/ws",
  authentication: { kind: "ticket" },
});

client.on("state", (state) => {
  status.textContent = state;
});
client.on("error", (error) => {
  status.textContent = `Realtime error: ${error.code}`;
});
client.connect().catch((error) => {
  status.textContent = `Unable to connect: ${error.code ?? "connection_failed"}`;
});
