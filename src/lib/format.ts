import { formatMoney } from "@/domain/money";

export function money(value: { toString(): string } | string | null | undefined, currency: string) {
  return formatMoney(value?.toString() ?? "0", currency);
}

export function dateLabel(date: Date | string | null | undefined, timezone = "UTC") {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  try {
    return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: timezone }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export function dateTimeLabel(date: Date | string | null | undefined, timezone = "UTC") {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  try {
    return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(d);
  } catch {
    return d.toISOString();
  }
}

export function relativeTime(date: Date | null | undefined) {
  if (!date) return "—";
  const diff = Date.now() - date.getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}
