import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const gatewayPort = Number.parseInt(process.env.REALTIME_BROWSER_GATEWAY_PORT ?? "18081", 10);
const proxyPort = Number.parseInt(process.env.REALTIME_BROWSER_PROXY_PORT ?? "18083", 10);
const staticPort = Number.parseInt(process.env.REALTIME_BROWSER_STATIC_PORT ?? "14173", 10);
const sessionCookie = {
  name: "cormier_session",
  value: "browser-session-123456",
  url: `http://127.0.0.1:${proxyPort}`,
  httpOnly: true,
  sameSite: "Strict",
};

async function exposeArtifact(page, name) {
  const content = await readFile(resolve(import.meta.dirname, "../../dist", name));
  await page.route(`http://127.0.0.1:${proxyPort}/sdk/${name}`, (route) => route.fulfill({
    status: 200,
    contentType: "text/javascript; charset=utf-8",
    body: content,
  }));
}

for (const artifact of [
  { format: "esm", name: "cormier-realtime.js" },
  { format: "esm", name: "cormier-realtime.min.js" },
  { format: "iife", name: "cormier-realtime.iife.js" },
  { format: "iife", name: "cormier-realtime.iife.min.js" },
]) {
  test(`${artifact.name} establishes an authorized connection and exchanges an event`, async ({ page, context }) => {
    await context.addCookies([sessionCookie]);
    await page.goto("/health/live");
    if (artifact.format === "esm") {
      await exposeArtifact(page, artifact.name);
      await page.addScriptTag({
        type: "module",
        content: `import * as sdk from '/sdk/${artifact.name}'; window.realtimeSdk = sdk;`,
      });
      await expect.poll(() => page.evaluate(() => typeof window.realtimeSdk?.RealtimeClient)).toBe("function");
    } else {
      await exposeArtifact(page, artifact.name);
      await page.addScriptTag({ url: `/sdk/${artifact.name}` });
      await page.evaluate(() => { window.realtimeSdk = window.CormierRealtime; });
    }

    const result = await page.evaluate(async () => {
      const client = new window.realtimeSdk.RealtimeClient({
        url: "/realtime/ws",
        authentication: { kind: "ticket" },
        heartbeatIntervalMilliseconds: 5_000,
      });
      await client.connect();
      const marker = crypto.randomUUID();
      const received = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("event timeout")), 5_000);
        void client.subscribe("topics/orders", (event) => {
          if (event.payload?.marker === marker) {
            clearTimeout(timeout);
            resolve(event.payload);
          }
        }).catch(reject);
      });
      await client.publish("topics/orders", { marker, value: 42 });
      const payload = await received;
      const state = client.state;
      await client.disconnect();
      return { payload, state };
    });

    expect(result.state).toBe("open");
    expect(result.payload.value).toBe(42);
  });
}

test("plain HTML loads the generated direct script and establishes a session-issued ticket connection", async ({ page, context }) => {
  await context.addCookies([sessionCookie]);
  await page.goto("/examples/browser/index.html");
  await expect(page.locator("#status")).toHaveText("open");
});

test("single-use and expired tickets are rejected without credential disclosure", async ({ page, context }) => {
  await context.addCookies([sessionCookie]);
  await page.goto("/health/live");
  const result = await page.evaluate(async () => {
    const response = await fetch("/realtime/tickets", { method: "POST", credentials: "include" });
    const { ticket } = await response.json();
    const connect = (candidate) => new Promise((resolve) => {
      const socket = new WebSocket(`/realtime/ws?ticket=${encodeURIComponent(candidate)}`, "cormier.realtime.v1");
      socket.onopen = () => {
        socket.close(1000, "test_complete");
        resolve("open");
      };
      socket.onerror = () => resolve("rejected");
    });
    return {
      first: await connect(ticket),
      reused: await connect(ticket),
      expired: await connect("expired-browser-ticket-12345678901234567890"),
    };
  });
  expect(result).toEqual({ first: "open", reused: "rejected", expired: "rejected" });
});

test("session authentication rejects a different browser Origin", async ({ page, context }) => {
  await context.addCookies([sessionCookie]);
  await page.goto(`http://127.0.0.1:${staticPort}/health`);
  const result = await page.evaluate((port) => new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/realtime/ws`, "cormier.realtime.v1");
    socket.onopen = () => resolve("open");
    socket.onerror = () => resolve("rejected");
  }), proxyPort);
  expect(result).toBe("rejected");
});

test("network failure reconnects through a different gateway with a fresh ticket and one restored subscription", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "Cross-replica behavior is transport-independent and runs once.");
  await context.addCookies([sessionCookie]);
  await page.goto("/health/live");
  await exposeArtifact(page, "cormier-realtime.js");
  await page.addScriptTag({ type: "module", content: "import * as sdk from '/sdk/cormier-realtime.js'; window.realtimeSdk = sdk;" });
  await expect.poll(() => page.evaluate(() => typeof window.realtimeSdk?.RealtimeClient)).toBe("function");
  await page.evaluate(async () => {
    const client = new window.realtimeSdk.RealtimeClient({
      url: "/realtime/ws",
      authentication: { kind: "ticket" },
      reconnect: { initialDelayMilliseconds: 10, maximumDelayMilliseconds: 50, jitterRatio: 0, maximumAttempts: 10 },
      heartbeatIntervalMilliseconds: 2_000,
    });
    window.crossReplicaClient = client;
    window.crossReplicaEvents = [];
    await client.connect();
    await client.subscribe("topics/orders", (event) => window.crossReplicaEvents.push(event));
  });
  const before = await page.request.get(`http://127.0.0.1:${proxyPort}/test/stats`).then((response) => response.json());
  await page.request.post(`http://127.0.0.1:${proxyPort}/test/drop`);
  await expect.poll(async () => {
    const stats = await page.request.get(`http://127.0.0.1:${proxyPort}/test/stats`).then((response) => response.json());
    return stats.websocketBackends.length;
  }).toBeGreaterThan(before.websocketBackends.length);
  await expect.poll(() => page.evaluate(() => window.crossReplicaClient.state)).toBe("open");

  const marker = crypto.randomUUID();
  await page.evaluate((value) => window.crossReplicaClient.publish("topics/orders", { marker: value }), marker);
  await expect.poll(() => page.evaluate((value) => window.crossReplicaEvents.filter((event) => event.payload?.marker === value).length, marker)).toBe(1);
  const after = await page.request.get(`http://127.0.0.1:${proxyPort}/test/stats`).then((response) => response.json());
  expect(after.websocketBackends.slice(-2)[0]).not.toBe(after.websocketBackends.slice(-2)[1]);
  expect(after.ticketRequests).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => window.crossReplicaClient.disconnect());
});

test("Redis fan-out preserves tenant isolation across gateway replicas", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "Cross-replica tenant isolation runs once.");
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  try {
    await firstContext.addCookies([sessionCookie]);
    await secondContext.addCookies([{ ...sessionCookie, value: "isolated-session-123456" }]);
    const first = await firstContext.newPage();
    const second = await secondContext.newPage();
    for (const page of [first, second]) {
      await exposeArtifact(page, "cormier-realtime.js");
      await page.goto(`http://127.0.0.1:${proxyPort}/health/live`);
      await page.addScriptTag({ type: "module", content: "import * as sdk from '/sdk/cormier-realtime.js'; window.realtimeSdk = sdk;" });
      await expect.poll(() => page.evaluate(() => typeof window.realtimeSdk?.RealtimeClient)).toBe("function");
      await page.evaluate(async () => {
        window.isolationEvents = [];
        window.isolationClient = new window.realtimeSdk.RealtimeClient({
          url: "/realtime/ws",
          authentication: { kind: "ticket" },
          heartbeatIntervalMilliseconds: 2_000,
        });
        await window.isolationClient.connect();
        await window.isolationClient.subscribe("topics/orders", (event) => window.isolationEvents.push(event));
      });
    }
    const marker = crypto.randomUUID();
    await first.evaluate((value) => window.isolationClient.publish("topics/orders", { marker: value }), marker);
    await expect.poll(() => first.evaluate((value) => window.isolationEvents.filter((event) => event.payload?.marker === value).length, marker)).toBe(1);
    await pageDelay(500);
    expect(await second.evaluate((value) => window.isolationEvents.some((event) => event.payload?.marker === value), marker)).toBe(false);
    await Promise.all([first.evaluate(() => window.isolationClient.disconnect()), second.evaluate(() => window.isolationClient.disconnect())]);
  } finally {
    await firstContext.close();
    await secondContext.close();
  }
});

function pageDelay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
