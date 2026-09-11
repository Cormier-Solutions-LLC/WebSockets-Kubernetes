import { expect, test } from "@playwright/test";

async function login(page) {
  await page.goto("/");
  await page.click("#login");
  await expect(page.locator("#events")).toContainText('"tenantId"');
}

test("shared UI completes login, connect, subscribe, publish, receive, reconnect, and logout", async ({ page }) => {
  await login(page);
  await expect(page.locator("#diagnostics")).toContainText(process.env.REFERENCE_STACK);
  await page.click("#connect");
  await expect(page.locator("#state")).toHaveText("open");
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
