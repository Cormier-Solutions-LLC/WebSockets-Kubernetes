import { RealtimeClient } from "/_content/Cormier.Realtime.Browser/cormier-realtime.js";

globalThis.RealtimeClient = RealtimeClient;
globalThis.CormierRealtime = { RealtimeClient };
await import("/app.js");
document.querySelector("#esm-state").textContent = "ready";
