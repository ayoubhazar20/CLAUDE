import Decimal from "decimal.js";
import { minorUnits } from "./currencies";

/**
 * Decimal-safe money helpers. Never use JS floating point for money:
 * every amount travels as a string or Decimal and is rounded explicitly.
 */
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof D>;

export type DecimalInput = string | number | Dec | { toString(): string };

export function dec(value: DecimalInput | null | undefined): Dec {
  if (value === null || value === undefined || value === "") return new D(0);
  if (value instanceof D) return value;
  const str = typeof value === "number" ? String(value) : value.toString().trim();
  if (!/^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(str)) {
    throw new Error(`Invalid decimal value: ${str}`);
  }
  return new D(str);
}

/** Round to the currency's minor units using ROUND_HALF_UP (commercial rounding). */
export function roundMoney(value: Dec, currency: string): Dec {
  return value.toDecimalPlaces(minorUnits(currency), D.ROUND_HALF_UP);
}

export function moneyString(value: Dec, currency: string): string {
  return roundMoney(value, currency).toFixed(minorUnits(currency));
}

export function formatMoney(value: DecimalInput, currency: string, locale = "en"): string {
  const amount = dec(value);
  const digits = minorUnits(currency);
  // Format integer and fraction parts separately to avoid float conversion of large values.
  const fixed = roundMoney(amount, currency).toFixed(digits);
  const negative = fixed.startsWith("-");
  const [intPart = "0", fracPart] = (negative ? fixed.slice(1) : fixed).split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const number = fracPart ? `${grouped}.${fracPart}` : grouped;
  void locale; // Localisation-ready: group/decimal separators can be derived from locale later.
  return `${negative ? "-" : ""}${number} ${currency}`;
}

export function isValidDecimalString(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value.trim());
}
