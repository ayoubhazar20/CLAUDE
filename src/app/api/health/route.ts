import { NextResponse } from "next/server";
import { prisma } from "@/server/db";

/** Liveness/readiness probe for uptime monitors (does not touch documents or view counters). */
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ status: "error" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
