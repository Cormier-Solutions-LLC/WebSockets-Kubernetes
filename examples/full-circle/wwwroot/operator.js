(() => {
  const output = document.querySelector("#output");
  const streams = new Set();
  let activeOverride;
  const write = (kind, value) => {
    output.textContent = `${new Date().toISOString()} ${kind} ${JSON.stringify(value)}\n${output.textContent}`.slice(0, 20000);
  };
  const settings = () => ({
    baseUrl: document.querySelector("#base").value.replace(/\/$/, ""),
    headers: { authorization: `Bearer ${document.querySelector("#token").value}` },
  });
  const invoke = async (action) => { try { await action(); } catch (error) { write("error", error.message); } };
  const stream = async (path, label) => {
    const controller = new AbortController(); streams.add(controller);
    const { baseUrl, headers } = settings();
    const response = await fetch(`${baseUrl}${path}`, { headers, signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`${label} failed with HTTP ${response.status}`);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let pending = "";
    while (!controller.signal.aborted) {
      const { value, done } = await reader.read(); if (done) break; pending += value;
      const records = pending.split("\n\n"); pending = records.pop();
      for (const record of records) {
        const data = record.split("\n").find(line => line.startsWith("data: "));
        if (data) write(label, JSON.parse(data.slice(6)));
      }
    }
  };
  document.querySelector("#snapshot").onclick = () => invoke(async () => {
    const client = new CormierRealtime.DiagnosticsClient(settings()); write("snapshot", await client.snapshot());
  });
  document.querySelector("#apply").onclick = () => invoke(async () => {
    const client = new CormierRealtime.DiagnosticsClient(settings());
    activeOverride = await client.applyLogLevel({
      category: document.querySelector("#category").value,
      level: document.querySelector("#level").value,
      durationSeconds: Number(document.querySelector("#duration").value),
      reason: document.querySelector("#reason").value,
      scope: "all",
    });
    document.querySelector("#revert").disabled = false;
    write("override", activeOverride);
  });
  document.querySelector("#revert").onclick = () => invoke(async () => {
    if (!activeOverride) return;
    const client = new CormierRealtime.DiagnosticsClient(settings());
    await client.revertLogLevel(activeOverride.id); write("override", { id: activeOverride.id, state: "reverted" });
    activeOverride = undefined; document.querySelector("#revert").disabled = true;
  });
  document.querySelector("#audit").onclick = () => invoke(async () => {
    const client = new CormierRealtime.DiagnosticsClient(settings()); write("audit", await client.audit());
  });
  document.querySelector("#events").onclick = () => invoke(() => stream("/events", "event"));
  document.querySelector("#logs").onclick = () => invoke(() => stream("/logs/tail?level=Information", "log"));
  document.querySelector("#stop").onclick = () => { for (const controller of streams) controller.abort(); streams.clear(); };
  setInterval(() => {
    const countdown = document.querySelector("#countdown");
    if (!activeOverride) { countdown.textContent = "not active"; return; }
    const seconds = Math.max(0, Math.ceil((Date.parse(activeOverride.expiresAt) - Date.now()) / 1000));
    countdown.textContent = `${seconds} seconds`;
    if (seconds === 0) { activeOverride = undefined; document.querySelector("#revert").disabled = true; }
  }, 1000);
})();
