import { NextResponse } from "next/server";
import { AppError, toErrorResponse } from "./errors";

/** Wrap a route handler: consistent JSON errors with trace ids, never stack traces. */
export function apiHandler<A extends unknown[]>(source: string, fn: (...args: A) => Promise<Response | unknown>) {
  return async (...args: A): Promise<Response> => {
    try {
      const result = await fn(...args);
      if (result instanceof Response) return result;
      return NextResponse.json(result ?? { ok: true });
    } catch (error) {
      const { status, body, headers } = await toErrorResponse(error, `api:${source}`);
      return NextResponse.json(body, { status, headers });
    }
  };
}

export async function readJson(req: Request, maxBytes = 1_000_000): Promise<unknown> {
  const text = await req.text();
  if (text.length > maxBytes) throw new AppError("Payload too large", 413, "PAYLOAD_TOO_LARGE");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new AppError("Invalid JSON body", 400, "INVALID_JSON");
  }
}
