// Site S4 (2.6) acceptance. The consent record is only worth keeping if it
// names the terms it was given for, and the page and the record have to name
// the same ones.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {offerSnapshot,orderRequestSchema} from "../server/product/orders/contracts.ts";
import {orderCheckout} from "../server/product/orders/service.ts";
import { TERMS_VERSION, termsVersionLabel } from "./legal-terms.ts";

vi.mock("server-only",()=>({}));

describe("the terms version", () => {
  it("is a date, so a reader can tell which text they agreed to", () => {
    expect(TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(Number.isNaN(Date.parse(TERMS_VERSION))).toBe(false);
  });

  it("prints the way the terms page prints it", () => {
    expect(termsVersionLabel("2026-08-22")).toBe("22.8.2026");
  });

  it("is the only place the version is written down", () => {
    // The failure this prevents: the page saying one date in prose while the
    // consent row stores another, which makes every stored consent ambiguous.
    const page = readFileSync(join(process.cwd(), "src", "app", "terms", "page.tsx"), "utf8");
    expect(page).toContain("termsVersionLabel()");
    expect(page).not.toMatch(/\d{1,2}\.\d{1,2}\.20\d\d/u);
  });

  it("pins both order snapshots to the server terms and rejects caller-selected versions", async () => {
    expect(offerSnapshot('initial').terms_version).toBe(TERMS_VERSION);
    expect(() => offerSnapshot('full')).toThrow('ORDER_PRICING_BASIS_UNAVAILABLE');
    expect(orderRequestSchema.safeParse({kind:'initial',from:'2026-06',to:'2026-06',terms_version:'2000-01-01'}).success).toBe(false);
    await expect(orderCheckout({caseId:'synthetic',identityId:null,orderId:'synthetic',termsAccepted:false},{provider:'fake',rpc:async()=>{throw new Error('CHECKOUT_MUST_NOT_REACH_STORE');}})).rejects.toThrow('ORDER_TERMS_REQUIRED');
    const route = readFileSync(join(process.cwd(), "src", "app", "api", "payments", "start", "route.ts"), "utf8");
    expect(route).toContain('createOrder');expect(route).toContain('orderCheckout');
  });
});
