import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const fixture = (name: string) => path.resolve("tests/fixtures", name);

test("login → upload separate zone files → map → validate → process → review exceptions → download", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Email").fill("e2e-admin@example.test");
  await page.getByLabel("Password").fill("e2e-password-123456");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  // Navigation is role-filtered: the admin sees every section.
  for (const label of [
    "Upload Scans",
    "Processing Jobs",
    "Cleaned Inventory",
    "Exceptions",
    "Reports",
    "Store Configuration",
    "Anchor Tags",
    "Users and Access",
    "Audit Logs",
    "Settings",
  ])
    await expect(
      page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: label }),
    ).toBeVisible();

  const nav = page.getByRole("navigation", { name: "Main" });
  await nav.getByRole("link", { name: "Upload Scans" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("File 1").setInputFiles(fixture("01_separate_sales_floor.csv"));
  await page.getByLabel("File 2").setInputFiles(fixture("01_separate_back_room.csv"));
  await page.getByRole("button", { name: "Upload and preview" }).click();

  // Mapping suggestions are pre-filled from the headers.
  await expect(
    page.getByRole("heading", { name: /Map columns — 01_separate_sales_floor.csv/ }),
  ).toBeVisible();
  await expect(page.locator('select[id$="-epc"]').first()).toHaveValue("EPC");
  await expect(page.locator('select[id$="-rssi"]').first()).toHaveValue("Peak RSSI");
  await page.getByRole("button", { name: "Validate all rows" }).click();
  await expect(page.getByText("Ready to process.").first()).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Start processing" }).click();

  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}/);
  await expect(page.getByText("COMPLETED", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "Raw observed vs cleaned inventory" })).toBeVisible();

  await page.getByRole("tab", { name: "Exceptions" }).click();
  await expect(page.locator("tbody tr").first()).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.locator('a[href$="/outputs/cleaned_sales_floor"]').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("cleaned_sales_floor.csv");
  const file = await download.path();
  const header = fs.readFileSync(file!, "utf8").split("\r\n")[0];
  expect(header).toBe(
    "job_id,store_id,epc,assigned_zone,confidence_score,confidence_type,classification_reason,processing_profile_version",
  );

  await nav.getByRole("link", { name: "Audit Logs" }).click();
  await expect(page.getByText("OUTPUT_DOWNLOADED").first()).toBeVisible();
});

test("rejects wrong credentials and unauthenticated API access", async ({ page, request }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("e2e-admin@example.test");
  await page.getByLabel("Password").fill("wrong-password-000");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".alert-bad")).toContainText("Invalid email or password");
  const res = await request.get("/api/v1/jobs");
  expect(res.status()).toBe(401);
  const health = await request.get("/api/ready");
  expect((await health.json()).checks.database).toBe("ok");
});
