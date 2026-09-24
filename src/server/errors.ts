import { ZodError } from "zod";
import { prisma } from "./db";
import { randomToken } from "./security/crypto";
import { RateLimitError } from "./security/rate-limit";

/** Application errors carry a safe, user-facing message and an HTTP status. */
export class AppError extends Error {
  constructor(
    message: string,
    public status: number = 400,
    public code: string = "BAD_REQUEST",
    public details?: unknown,
  ) {
    super(message);
  }
}

export class NotFoundError extends AppError {
  constructor(what = "Resource") {
    super(`${what} not found`, 404, "NOT_FOUND");
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to perform this action") {
    super(message, 403, "FORBIDDEN");
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Please sign in to continue") {
    super(message, 401, "UNAUTHORIZED");
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = "CONFLICT") {
    super(message, 409, code);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 422, "VALIDATION_ERROR", details);
  }
}

export function newTraceId(): string {
  return `err_${randomToken(9)}`;
}

/**
 * Persist an unexpected error with a traceable id. The id — never the stack —
 * is shown to the user.
 */
export async function logError(
  error: unknown,
  context: { source: string; organizationId?: string | null; userId?: string | null; extra?: Record<string, unknown> },
): Promise<string> {
  const traceId = newTraceId();
  const err = error instanceof Error ? error : new Error(String(error));
  console.error(`[${traceId}] ${context.source}:`, err);
  try {
    await prisma.errorLog.create({
      data: {
        traceId,
        source: context.source.slice(0, 200),
        message: err.message.slice(0, 2000),
        stack: err.stack?.slice(0, 10000) ?? null,
        organizationId: context.organizationId ?? null,
        userId: context.userId ?? null,
        context: (context.extra ?? {}) as object,
      },
    });
  } catch (logFailure) {
    console.error("Failed to persist error log", logFailure);
  }
  return traceId;
}

export interface ErrorPayload {
  error: { message: string; code: string; traceId?: string; details?: unknown };
}

/** Convert any thrown value into a safe JSON payload + status. */
export async function toErrorResponse(error: unknown, source: string, ids?: { organizationId?: string | null; userId?: string | null }): Promise<{ status: number; body: ErrorPayload; headers?: Record<string, string> }> {
  if (error instanceof AppError) {
    return { status: error.status, body: { error: { message: error.message, code: error.code, details: error.details } } };
  }
  if (error instanceof ZodError) {
    return {
      status: 422,
      body: { error: { message: "Some fields are invalid", code: "VALIDATION_ERROR", details: error.flatten() } },
    };
  }
  if (error instanceof RateLimitError) {
    return {
      status: 429,
      body: { error: { message: error.message, code: "RATE_LIMITED" } },
      headers: { "Retry-After": String(error.retryAfterSeconds) },
    };
  }
  const traceId = await logError(error, { source, ...ids });
  return {
    status: 500,
    body: { error: { message: `Something went wrong. Reference: ${traceId}`, code: "INTERNAL_ERROR", traceId } },
  };
}
