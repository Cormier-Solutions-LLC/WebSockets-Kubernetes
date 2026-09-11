import { expect, test } from "@playwright/test";

async function login(page) {
  await page.goto("/");
  await page.click("#login");
  await expect(page.locator("#events")).toContainText('"tenantId"');
}

test("optimized shared UI keeps integrity, CSP, and accessible controls", async ({ page }) => {
  const pageErrors = [];
  const failedRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => failedRequests.push(`${request.url()}: ${request.failure()?.errorText ?? "failed"}`));

  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toContain("default-src 'self'");
  await expect(page.locator("#diagnostics")).toContainText(process.env.REFERENCE_STACK);
  await expect(page.locator('link[rel="stylesheet"]')).toHaveAttribute("integrity", /^sha384-/u);
  await expect(page.locator('script[src$="cormier-realtime.iife.min.js"]')).toHaveAttribute("integrity", /^sha384-/u);
  await expect(page.locator('script[src="/app.js"]')).toHaveAttribute("integrity", /^sha384-/u);
  await expect(page.getByRole("heading", { name: "Cormier.Realtime full circle", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Tenant")).toBeVisible();
  await expect(page.getByLabel("User")).toBeVisible();
  await expect(page.getByLabel("Route")).toBeVisible();
  await expect(page.getByLabel("Payload")).toBeVisible();
  await expect(page.locator("#events")).toHaveAttribute("aria-live", "polite");
  expect(pageErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test("shared UI completes login, ticket connect, subscribe, publish, receive, reconnect, and logout", async ({ page, request }) => {
  await login(page);
  await expect(page.locator("#diagnostics")).toContainText(process.env.REFERENCE_STACK);
  await page.click("#connect");
  await expect(page.locator("#state")).toHaveText("open");

  await expect.poll(async () => {
    const metrics = await request.get(`${process.env.REFERENCE_GATEWAY_URL}/metrics`);
    return metrics.ok() ? await metrics.text() : "";
  }).toMatch(/cormier_realtime_authentication_total\{method="ticket",outcome="success"} [1-9][0-9]*/);
  await page.click("#subscribe");
  await expect(page.locator("#events")).toContainText("subscribed");

  const firstMarker = crypto.randomUUID();
  await page.fill("#payload", JSON.stringify({ marker: firstMarker }));
  await page.click("#publish");
  await expect(page.locator("#events")).toContainText(firstMarker);

  await page.click("#disconnect");
  await expect(page.locator("#state")).toHaveText("closed");
  await page.click("#connect");
  await expect(page.locator("#state")).toHaveText("open");

  await page.click("#logout");
  await expect(page.locator("#events")).toContainText("logged out");
  await page.click("#disconnect");
});

test("anonymous, invalid identity, and rejected Origin requests fail safely", async ({ page, request }) => {
  await page.goto("/");
  await page.click("#connect");
  await expect(page.locator("#events")).toContainText("error");

  const invalid = await request.post("/api/login", {
    headers: { Origin: new URL(process.env.REFERENCE_BASE_URL).origin },
    data: { tenantId: "unknown", userId: "unknown" },
  });
  expect(invalid.status()).toBe(400);

  const rejected = await request.post("/api/login", {
    headers: { Origin: "https://untrusted.invalid" },
    data: { tenantId: "tenant-a", userId: "user-a" },
  });
  expect(rejected.status()).toBe(403);
});
