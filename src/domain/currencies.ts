/** Supported document currencies. Currency belongs to each document; changing it never converts prices. */
export const CURRENCIES = {
  MAD: { code: "MAD", name: "Moroccan Dirham", minorUnits: 2 },
  USD: { code: "USD", name: "US Dollar", minorUnits: 2 },
  EUR: { code: "EUR", name: "Euro", minorUnits: 2 },
  GBP: { code: "GBP", name: "British Pound", minorUnits: 2 },
  CAD: { code: "CAD", name: "Canadian Dollar", minorUnits: 2 },
} as const;

export type CurrencyCode = keyof typeof CURRENCIES;
export const CURRENCY_CODES = Object.keys(CURRENCIES) as CurrencyCode[];
export const DEFAULT_CURRENCY: CurrencyCode = "MAD";

export function isCurrencyCode(value: string): value is CurrencyCode {
  return Object.prototype.hasOwnProperty.call(CURRENCIES, value);
}

export function minorUnits(currency: string): number {
  return isCurrencyCode(currency) ? CURRENCIES[currency].minorUnits : 2;
}
