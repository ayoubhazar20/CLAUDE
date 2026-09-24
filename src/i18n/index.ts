import { en, type Messages } from "./en";

/**
 * Localisation-ready message catalogue. The UI ships in English; additional
 * locales are added by providing another `Messages` object.
 */
const catalogs: Record<string, Messages> = { en };

export type MessageKey = keyof Messages;

export function t(key: MessageKey, vars?: Record<string, string | number>, locale = "en"): string {
  const template = (catalogs[locale] ?? en)[key] ?? en[key] ?? key;
  return vars ? template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? "")) : template;
}
