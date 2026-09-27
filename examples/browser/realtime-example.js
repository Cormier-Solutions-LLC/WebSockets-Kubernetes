"use strict";

const status = document.querySelector("#status");
const mode = location.pathname.endsWith("fallback.html") ? "fallback"
  : location.pathname.endsWith("failover.html") ? "failover" : "websocket";
const control = document.querySelector("#websocket-control");
control.hidden = mode !== "failover";
const client = new CormierRealtime.RealtimeClient({
  url: "/realtime/ws",
  authentication: { kind: "ticket" },
  ...(mode === "fallback" ? { transports: ["http-streaming"], httpStreaming: { url: "/realtime/http" } } : {}),
  ...(mode === "failover" ? {
    transports: ["websocket", "http-streaming"],
    httpStreaming: { url: "/realtime/http" },
    ...(document.querySelector("#disable-websocket").checked
      ? { webSocketFactory: () => { throw new Error("WebSockets disabled by the example page."); } } : {}),
  } : {}),
});

client.on("state", (state) => {
  status.textContent = `${state}${client.activeTransport ? ` (${client.activeTransport})` : ""}`;
});
client.on("error", (error) => {
  status.textContent = `Realtime error: ${error.code}`;
});
client.connect().catch((error) => {
  status.textContent = `Unable to connect: ${error.code ?? "connection_failed"}`;
});
