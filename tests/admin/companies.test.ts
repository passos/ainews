import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createCompany,
  listCompanies,
  toggleCompanyTracking,
} from "../../src/server/admin/ops";

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM financial_facts`).run();
  await env.DB.prepare(`DELETE FROM filings`).run();
  await env.DB.prepare(`DELETE FROM companies`).run();
});

describe("Admin Companies Operations", () => {
  it("creates, lists, and toggles company tracking", async () => {
    // 1. Create company
    const companyId = await createCompany(env.DB, {
      cik: "1045810",
      ticker: "nvda",
      name: "NVIDIA Corp",
    });

    expect(companyId).toBeGreaterThan(0);

    // 2. List companies
    const list = await listCompanies(env.DB);
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(companyId);
    expect(list[0].ticker).toBe("NVDA"); // Normalized to uppercase
    expect(list[0].cik).toBe("0001045810"); // Zero-padded 10 digits
    expect(list[0].name).toBe("NVIDIA Corp");
    expect(list[0].tracked).toBe(1);

    // 3. Toggle tracking
    await toggleCompanyTracking(env.DB, companyId, 0);
    const updatedList = await listCompanies(env.DB);
    expect(updatedList[0].tracked).toBe(0);

    // 4. Resume tracking
    await toggleCompanyTracking(env.DB, companyId, 1);
    const resumedList = await listCompanies(env.DB);
    expect(resumedList[0].tracked).toBe(1);
  });
});
