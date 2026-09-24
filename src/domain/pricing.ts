import { D, dec, moneyString, roundMoney, type Dec } from "./money";

/**
 * Pricing engine.
 *
 * Deterministic calculation order:
 *  1. line gross       = quantity × unit price                         (rounded to minor units)
 *  2. line discount    = % of gross, or fixed amount (clamped 0..gross) (line net rounded)
 *  3. subtotal         = Σ line net (optional lines excluded)
 *  4. global discount  = % of subtotal, or fixed amount (clamped 0..subtotal)
 *  5. fees             = fixed amounts added after discounts
 *  6. taxes            = rate × (discounted taxable line nets + taxable fees), rounded per tax
 *  7. grand total      = subtotal − global discount + fees + taxes
 *
 * The global discount is allocated to lines proportionally to their net, which is
 * only used to compute taxable bases (so taxes apply to the discounted amounts).
 */

export type DiscountKind = "NONE" | "PERCENT" | "AMOUNT";

export interface PricingLineInput {
  key: string;
  quantity: string;
  unitPrice: string;
  discountType: DiscountKind;
  discountValue: string;
  taxKeys: string[];
  optional?: boolean;
}

export interface TaxDefinition {
  key: string;
  name: string;
  /** Percentage, e.g. "20" for 20 %. */
  rate: string;
}

export interface FeeDefinition {
  key: string;
  name: string;
  amount: string;
  taxKeys: string[];
}

export interface PricingConfig {
  globalDiscountType: DiscountKind;
  globalDiscountValue: string;
  taxes: TaxDefinition[];
  fees: FeeDefinition[];
}

export const EMPTY_PRICING_CONFIG: PricingConfig = {
  globalDiscountType: "NONE",
  globalDiscountValue: "0",
  taxes: [],
  fees: [],
};

export interface LineTotals {
  key: string;
  gross: string;
  discount: string;
  net: string;
  optional: boolean;
}

export interface TaxTotal {
  key: string;
  name: string;
  rate: string;
  base: string;
  amount: string;
}

export interface PricingTotals {
  currency: string;
  lines: LineTotals[];
  itemsGross: string;
  lineDiscountTotal: string;
  subtotal: string;
  globalDiscount: string;
  discountTotal: string;
  fees: { key: string; name: string; amount: string }[];
  feesTotal: string;
  taxes: TaxTotal[];
  taxTotal: string;
  grandTotal: string;
}

export class PricingError extends Error {}

function assertNonNegative(value: Dec, label: string) {
  if (value.isNegative()) throw new PricingError(`${label} cannot be negative`);
}

function computeDiscount(base: Dec, type: DiscountKind, rawValue: string, currency: string, label: string): Dec {
  if (type === "NONE") return new D(0);
  const value = dec(rawValue);
  assertNonNegative(value, label);
  if (type === "PERCENT") {
    if (value.greaterThan(100)) throw new PricingError(`${label} percentage cannot exceed 100`);
    return roundMoney(base.times(value).dividedBy(100), currency);
  }
  const amount = roundMoney(value, currency);
  return D.min(amount, base);
}

export function calculatePricing(
  lines: PricingLineInput[],
  config: PricingConfig,
  currency: string,
): PricingTotals {
  for (const tax of config.taxes) {
    const rate = dec(tax.rate);
    assertNonNegative(rate, `Tax "${tax.name}" rate`);
    if (rate.greaterThan(100)) throw new PricingError(`Tax "${tax.name}" rate cannot exceed 100`);
  }

  const lineTotals: LineTotals[] = [];
  let itemsGross = new D(0);
  let lineDiscountTotal = new D(0);
  let subtotal = new D(0);

  for (const line of lines) {
    const quantity = dec(line.quantity);
    const unitPrice = dec(line.unitPrice);
    assertNonNegative(quantity, "Quantity");
    assertNonNegative(unitPrice, "Unit price");
    const gross = roundMoney(quantity.times(unitPrice), currency);
    const discount = computeDiscount(gross, line.discountType, line.discountValue, currency, "Line discount");
    const net = gross.minus(discount);
    const optional = Boolean(line.optional);
    lineTotals.push({
      key: line.key,
      gross: gross.toFixed(),
      discount: discount.toFixed(),
      net: net.toFixed(),
      optional,
    });
    if (!optional) {
      itemsGross = itemsGross.plus(gross);
      lineDiscountTotal = lineDiscountTotal.plus(discount);
      subtotal = subtotal.plus(net);
    }
  }

  const globalDiscount = computeDiscount(
    subtotal,
    config.globalDiscountType,
    config.globalDiscountValue,
    currency,
    "Global discount",
  );
  // Ratio applied to line nets to obtain discounted taxable bases.
  const discountRatio = subtotal.isZero() ? new D(1) : subtotal.minus(globalDiscount).dividedBy(subtotal);

  const fees = config.fees.map((fee) => {
    const amount = roundMoney(dec(fee.amount), currency);
    assertNonNegative(amount, `Fee "${fee.name}"`);
    return { key: fee.key, name: fee.name, amount, taxKeys: fee.taxKeys };
  });
  const feesTotal = fees.reduce((sum, f) => sum.plus(f.amount), new D(0));

  const taxes: TaxTotal[] = config.taxes.map((tax) => {
    let base = new D(0);
    lines.forEach((line, index) => {
      const totals = lineTotals[index]!;
      if (totals.optional || !line.taxKeys.includes(tax.key)) return;
      base = base.plus(dec(totals.net).times(discountRatio));
    });
    for (const fee of fees) {
      if (fee.taxKeys.includes(tax.key)) base = base.plus(fee.amount);
    }
    const roundedBase = roundMoney(base, currency);
    const amount = roundMoney(base.times(dec(tax.rate)).dividedBy(100), currency);
    return { key: tax.key, name: tax.name, rate: dec(tax.rate).toFixed(), base: roundedBase.toFixed(), amount: amount.toFixed() };
  });

  const taxTotal = taxes.reduce((sum, t) => sum.plus(dec(t.amount)), new D(0));
  const grandTotal = subtotal.minus(globalDiscount).plus(feesTotal).plus(taxTotal);

  const fmt = (v: Dec) => moneyString(v, currency);
  return {
    currency,
    lines: lineTotals.map((l) => ({
      ...l,
      gross: fmt(dec(l.gross)),
      discount: fmt(dec(l.discount)),
      net: fmt(dec(l.net)),
    })),
    itemsGross: fmt(itemsGross),
    lineDiscountTotal: fmt(lineDiscountTotal),
    subtotal: fmt(subtotal),
    globalDiscount: fmt(globalDiscount),
    discountTotal: fmt(lineDiscountTotal.plus(globalDiscount)),
    fees: fees.map((f) => ({ key: f.key, name: f.name, amount: fmt(f.amount) })),
    feesTotal: fmt(feesTotal),
    taxes: taxes.map((t) => ({ ...t, base: fmt(dec(t.base)), amount: fmt(dec(t.amount)) })),
    taxTotal: fmt(taxTotal),
    grandTotal: fmt(grandTotal),
  };
}
