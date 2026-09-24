import { ZodError } from "zod";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { AppError, logError } from "./errors";
import { RateLimitError } from "./security/rate-limit";
import type { ActionState } from "@/lib/action-state";

/**
 * Run a server action body and convert failures into a safe ActionState.
 * Redirects (thrown by next/navigation) are re-thrown so they still work.
 */
export async function runAction<T>(source: string, fn: () => Promise<ActionState<T> | void>): Promise<ActionState<T>> {
  try {
    const result = await fn();
    return result ?? { ok: true };
  } catch (error) {
    if (isRedirectError(error)) throw error;
    if (error instanceof ZodError) {
      const flat = error.flatten();
      const first = Object.values(flat.fieldErrors).flat()[0] ?? flat.formErrors[0];
      return { ok: false, error: first ?? "Some fields are invalid.", fieldErrors: flat.fieldErrors as Record<string, string[]> };
    }
    if (error instanceof AppError) {
      const details = error.details as { fieldErrors?: Record<string, string[]>; problems?: string[] } | undefined;
      return { ok: false, error: error.message, code: error.code, fieldErrors: details?.fieldErrors };
    }
    if (error instanceof RateLimitError) return { ok: false, error: error.message, code: "RATE_LIMITED" };
    const traceId = await logError(error, { source: `action:${source}` });
    return { ok: false, error: `Something went wrong. Reference: ${traceId}`, code: "INTERNAL_ERROR" };
  }
}

export function formString(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
}

export function formBool(form: FormData, key: string): boolean {
  const v = form.get(key);
  return v === "on" || v === "true" || v === "1";
}
