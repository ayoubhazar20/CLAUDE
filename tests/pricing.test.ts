import { describe, expect, it } from "vitest";
import { calculatePricing, PricingError, type PricingConfig, type PricingLineInput } from "@/domain/pricing";
import { formatMoney } from "@/domain/money";

const noConfig: PricingConfig = { globalDiscountType: "NONE", globalDiscountValue: "0", taxes: [], fees: [] };
const line = (over: Partial<PricingLineInput> = {}): PricingLineInput => ({
  key: over.key ?? "l1",
  quantity: "1",
  unitPrice: "100",
  discountType: "NONE",
  discountValue: "0",
  taxKeys: [],
  ...over,
});

describe("pricing engine", () => {
  it("avoids floating point errors (0.1 + 0.2)", () => {
    const t = calculatePricing([line({ key: "a", unitPrice: "0.1" }), line({ key: "b", unitPrice: "0.2" })], noConfig, "USD");
    expect(t.subtotal).toBe("0.30");
    expect(t.grandTotal).toBe("0.30");
  });

  it("multiplies quantity by unit price with decimal quantities", () => {
    const t = calculatePricing([line({ quantity: "2.5", unitPrice: "19.99" })], noConfig, "EUR");
    // 49.975 → 49.98 (half-up)
    expect(t.lines[0]!.gross).toBe("49.98");
    expect(t.grandTotal).toBe("49.98");
  });

  it("applies percentage and fixed line discounts", () => {
    const t = calculatePricing(
      [line({ key: "a", quantity: "10", unitPrice: "1500", discountType: "PERCENT", discountValue: "10" }), line({ key: "b", quantity: "2", unitPrice: "1750.50", discountType: "AMOUNT", discountValue: "100" })],
      noConfig,
      "MAD",
    );
    expect(t.lines[0]!.discount).toBe("1500.00");
    expect(t.lines[0]!.net).toBe("13500.00");
    expect(t.lines[1]!.net).toBe("3401.00");
    expect(t.itemsGross).toBe("18501.00");
    expect(t.lineDiscountTotal).toBe("1600.00");
    expect(t.subtotal).toBe("16901.00");
  });

  it("clamps a fixed discount to the line amount", () => {
    const t = calculatePricing([line({ unitPrice: "50", discountType: "AMOUNT", discountValue: "80" })], noConfig, "USD");
    expect(t.lines[0]!.net).toBe("0.00");
    expect(t.grandTotal).toBe("0.00");
  });

  it("rejects percentages above 100 and negative values", () => {
    expect(() => calculatePricing([line({ discountType: "PERCENT", discountValue: "120" })], noConfig, "USD")).toThrow(PricingError);
    expect(() => calculatePricing([line({ unitPrice: "-5" })], noConfig, "USD")).toThrow(PricingError);
    expect(() => calculatePricing([line({ quantity: "abc" })], noConfig, "USD")).toThrow();
  });

  it("applies global percentage discount before taxes", () => {
    const config: PricingConfig = { globalDiscountType: "PERCENT", globalDiscountValue: "10", taxes: [{ key: "vat", name: "VAT", rate: "20" }], fees: [] };
    const t = calculatePricing([line({ quantity: "1", unitPrice: "1000", taxKeys: ["vat"] })], config, "MAD");
    expect(t.subtotal).toBe("1000.00");
    expect(t.globalDiscount).toBe("100.00");
    expect(t.taxes[0]!.base).toBe("900.00");
    expect(t.taxTotal).toBe("180.00");
    expect(t.grandTotal).toBe("1080.00");
    expect(t.discountTotal).toBe("100.00");
  });

  it("applies a fixed global discount proportionally for tax bases", () => {
    const config: PricingConfig = { globalDiscountType: "AMOUNT", globalDiscountValue: "300", taxes: [{ key: "vat", name: "VAT", rate: "20" }], fees: [] };
    // Only line A (1000) is taxable; B (500) is not. Discount 300 on 1500 → ratio 0.8.
    const t = calculatePricing([line({ key: "a", unitPrice: "1000", taxKeys: ["vat"] }), line({ key: "b", unitPrice: "500" })], config, "USD");
    expect(t.taxes[0]!.base).toBe("800.00");
    expect(t.taxTotal).toBe("160.00");
    expect(t.grandTotal).toBe("1360.00");
  });

  it("supports multiple taxes and taxable fees", () => {
    const config: PricingConfig = {
      globalDiscountType: "NONE",
      globalDiscountValue: "0",
      taxes: [
        { key: "vat", name: "VAT", rate: "20" },
        { key: "city", name: "City tax", rate: "2.5" },
      ],
      fees: [{ key: "ship", name: "Shipping", amount: "100", taxKeys: ["vat"] }],
    };
    const t = calculatePricing([line({ unitPrice: "1000", taxKeys: ["vat", "city"] })], config, "EUR");
    expect(t.feesTotal).toBe("100.00");
    expect(t.taxes.find((x) => x.key === "vat")!.amount).toBe("220.00");
    expect(t.taxes.find((x) => x.key === "city")!.amount).toBe("25.00");
    expect(t.grandTotal).toBe("1345.00");
  });

  it("excludes optional lines from totals", () => {
    const t = calculatePricing([line({ key: "a", unitPrice: "100" }), line({ key: "b", unitPrice: "999", optional: true })], noConfig, "USD");
    expect(t.subtotal).toBe("100.00");
  });

  it("is deterministic for large amounts", () => {
    const t = calculatePricing([line({ quantity: "1000000", unitPrice: "99999999.99" })], noConfig, "USD");
    expect(t.grandTotal).toBe("99999999990000.00");
  });

  it("rounds per tax with half-up rounding", () => {
    const config: PricingConfig = { globalDiscountType: "NONE", globalDiscountValue: "0", taxes: [{ key: "t", name: "T", rate: "7.5" }], fees: [] };
    const t = calculatePricing([line({ unitPrice: "10.10", taxKeys: ["t"] })], config, "USD");
    // 10.10 × 7.5% = 0.7575 → 0.76
    expect(t.taxTotal).toBe("0.76");
    expect(t.grandTotal).toBe("10.86");
  });

  it("formats money without float conversion", () => {
    expect(formatMoney("18500", "MAD")).toBe("18,500.00 MAD");
    expect(formatMoney("1234567.895", "USD")).toBe("1,234,567.90 USD");
    expect(formatMoney("-12.5", "EUR")).toBe("-12.50 EUR");
  });
});
