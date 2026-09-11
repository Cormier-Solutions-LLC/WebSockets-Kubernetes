(() => {
  const output = document.querySelector("#events");
  const state = document.querySelector("#state");
  let client;
  let unsubscribe;
  const write = (kind, value) => {
    const safe = typeof value === "string" ? value : JSON.stringify(value);
    output.textContent = `${new Date().toISOString()} ${kind} ${safe}\n${output.textContent}`.slice(0, 12000);
  };
  const invoke = async (action) => { try { await action(); } catch (error) { write("error", { name: error.name, code: error.code, message: error.message }); } };
  fetch("/api/diagnostics").then(r => r.json()).then(value => {
    const stack = value.stack ? `Stack: ${value.stack}; ` : "";
    document.querySelector("#diagnostics").textContent = `${stack}Topology: ${value.topology}; instance: ${value.instance}; Redis: ${value.redis}`;
    const links = document.querySelector("#stack-links");
    for (const item of Array.isArray(value.links) ? value.links : []) {
      if (typeof item?.href !== "string" || !item.href.startsWith("/") || typeof item.label !== "string") continue;
      const paragraph = document.createElement("p");
      const anchor = document.createElement("a");
      anchor.href = item.href;
      anchor.textContent = item.label;
      paragraph.append(anchor);
      links.append(paragraph);
    }
  }).catch(error => write("diagnostics", error.message));
  document.querySelector("#login").onclick = () => invoke(async () => {
    const response = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: document.querySelector("#tenant").value, userId: document.querySelector("#user").value }) });
    const value = await response.json(); if (!response.ok) throw new Error(value.message); write("session", value);
  });
  document.querySelector("#logout").onclick = () => invoke(async () => {
    const response = await fetch("/api/logout", { method: "POST" });
    if (!response.ok) {
      const value = await response.json().catch(() => ({}));
      throw new Error(value.message || "Logout failed.");
    }
    write("session", "logged out");
  });
  document.querySelector("#connect").onclick = () => invoke(async () => {
    client = new CormierRealtime.RealtimeClient({ url: "/realtime/ws", authentication: { kind: "ticket" },
      reconnect: { initialDelayMilliseconds: 50, maximumDelayMilliseconds: 500, jitterRatio: 0, maximumAttempts: 20 } });
    client.on("state", value => { state.textContent = value; write("state", value); });
    client.on("error", error => write("error", { code: error.code, message: error.message }));
    client.on("close", value => write("close", value)); await client.connect();
  });
  document.querySelector("#disconnect").onclick = () => invoke(() => client.disconnect());
  document.querySelector("#subscribe").onclick = () => invoke(async () => {
    const route = document.querySelector("#route").value; unsubscribe = await client.subscribe(route, event => write("event", event)); write("subscribed", route);
  });
  document.querySelector("#unsubscribe").onclick = () => invoke(async () => { if (unsubscribe) await unsubscribe(); unsubscribe = undefined; write("unsubscribed", "ok"); });
  document.querySelector("#publish").onclick = () => invoke(async () => {
    const payload = JSON.parse(document.querySelector("#payload").value); await client.publish(document.querySelector("#route").value, payload); write("published", payload);
  });
  window.fullCircle = { get client() { return client; } };
})();
