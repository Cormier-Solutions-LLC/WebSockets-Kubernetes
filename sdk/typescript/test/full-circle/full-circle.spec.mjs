import { expect, test } from "@playwright/test";

async function login(page, tenant = "tenant-a", user = "user-a") {
  await page.goto("/");
  await page.locator("#tenant").fill(tenant);
  await page.locator("#user").fill(user);
  await page.click("#login");
  await expect(page.locator("#events")).toContainText('"tenantId"');
}

async function connectAndSubscribe(page) {
  await page.click("#connect");
  await expect(page.locator("#state")).toHaveText("open");
  await page.click("#subscribe");
  await expect(page.locator("#events")).toContainText("subscribed");
}

test("packaged browser assets expose both direct-script and ESM consumers", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#diagnostics")).toContainText(`Topology: ${process.env.FULL_CIRCLE_PROFILE}`);
  expect(await page.evaluate(() => typeof window.CormierRealtime?.RealtimeClient)).toBe("function");
  await page.goto("/esm.html");
  await expect(page.locator("#state")).toHaveText("ready");
  expect(await page.evaluate(() => typeof window.RealtimeClient)).toBe("function");
});

test("operator view exposes diagnostics controls separately from ordinary roles", async ({ page }) => {
  const anonymous = await page.request.get("/diagnostics/v1/snapshot");
  expect(anonymous.status()).toBe(401);

  await page.goto("/operator.html");
  await expect(page.locator("h1")).toHaveText("Operator diagnostics");
  await expect(page.locator("#token")).toHaveAttribute("type", "password");
  await expect(page.locator("#countdown")).toHaveText("not active");
  await expect(page.locator("#revert")).toBeDisabled();
  expect(await page.evaluate(() => typeof window.CormierRealtime?.DiagnosticsClient)).toBe("function");

  await page.fill("#token", process.env.FULL_CIRCLE_DIAGNOSTICS_TOKEN);
  await page.click("#snapshot");
  await expect(page.locator("#output")).toContainText("snapshot");
  await expect(page.locator("#output")).toContainText("instanceId");
});

test("anonymous and invalid identities fail visibly without exposing credentials", async ({ page }) => {
  await page.goto("/");
  await page.click("#connect");
  await expect(page.locator("#events")).toContainText("error");
  const response = await page.request.post("/api/login", { data: { tenantId: "unknown", userId: "unknown" } });
  expect(response.status()).toBe(400);
  expect(await response.json()).toMatchObject({ code: "invalid_identity" });
});

test("login, ticket authentication, subscribe, publish, receive, and unsubscribe complete the round trip", async ({ page }) => {
  await login(page);
  await connectAndSubscribe(page);
  const marker = crypto.randomUUID();
  await page.fill("#payload", JSON.stringify({ marker }));
  await page.click("#publish");
  await expect(page.locator("#events")).toContainText(marker);
  await page.click("#unsubscribe");
  await expect(page.locator("#events")).toContainText("unsubscribed");
  await page.click("#disconnect");
  await expect(page.locator("#state")).toHaveText("closed");
});

test("invalid routes and invalid payloads produce structured visible errors", async ({ page }) => {
  await login(page);
  await connectAndSubscribe(page);
  await page.fill("#route", "not/a/supported/route/value");
  await page.click("#subscribe");
  await expect(page.locator("#events")).toContainText("error");
  await page.fill("#payload", "not-json");
  await page.click("#publish");
  await expect(page.locator("#events")).toContainText("SyntaxError");
});

test("Redis fan-out crosses instances and preserves tenant boundaries", async ({ browser, request }) => {
  test.skip(process.env.FULL_CIRCLE_PROFILE !== "ha", "Requires the explicit HA topology.");
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const isolatedContext = await browser.newContext();
  try {
    const first = await firstContext.newPage();
    const second = await secondContext.newPage();
    const isolated = await isolatedContext.newPage();
    await login(first, "tenant-a", "user-a");
    await login(second, "tenant-a", "user-a");
    await login(isolated, "tenant-b", "user-b");
    const before = await request.get("/test/stats").then(response => response.json());
    await connectAndSubscribe(first);
    await connectAndSubscribe(second);
    const connected = await request.get("/test/stats").then(response => response.json());
    const newBackends = connected.websocketBackends.slice(before.websocketBackends.length);
    expect(newBackends).toHaveLength(2);
    expect(newBackends[0]).not.toBe(newBackends[1]);
    await connectAndSubscribe(isolated);
    const marker = crypto.randomUUID();
    await first.fill("#payload", JSON.stringify({ marker }));
    await first.click("#publish");
    await expect(first.locator("#events")).toContainText(marker);
    await expect(second.locator("#events")).toContainText(marker);
    await pageDelay(500);
    await expect(isolated.locator("#events")).not.toContainText(marker);
  } finally {
    await firstContext.close();
    await secondContext.close();
    await isolatedContext.close();
  }
});

test("HA reconnect selects another instance and restores one subscription", async ({ page, request }) => {
  test.skip(process.env.FULL_CIRCLE_PROFILE !== "ha", "Requires the explicit HA topology.");
  await login(page);
  await connectAndSubscribe(page);
  const before = await request.get("/test/stats").then(response => response.json());
  await request.post("/test/drop");
  await expect(page.locator("#state")).toHaveText("open");
  const marker = crypto.randomUUID();
  await page.fill("#payload", JSON.stringify({ marker }));
  await page.click("#publish");
  await expect(page.locator("#events")).toContainText(marker);
  const after = await request.get("/test/stats").then(response => response.json());
  expect(after.websocketBackends.length).toBeGreaterThan(before.websocketBackends.length);
  expect(after.websocketBackends.at(-1)).not.toBe(after.websocketBackends.at(-2));
  expect(after.ticketRequests).toBeGreaterThan(before.ticketRequests);
  const eventLines = (await page.locator("#events").textContent()).split("\n")
    .filter(line => line.includes(" event ") && line.includes(marker));
  expect(eventLines).toHaveLength(1);
});

function pageDelay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
