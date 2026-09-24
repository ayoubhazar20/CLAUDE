import type { DocumentStatus, DocumentType, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import type { OrgContext } from "../auth/context";
import { teamScopeUserIds } from "../services/members";
import { documentViewFilter } from "./access";
import { analyticsScope } from "@/domain/permissions";

export const listFiltersSchema = z.object({
  q: z.string().trim().max(200).optional(),
  type: z.enum(["QUOTE", "CONTRACT"]).optional(),
  status: z.enum(["DRAFT", "PUBLISHED", "SENT", "VIEWED", "AWAITING_SIGNATURE", "ACCEPTED", "SIGNED", "REJECTED", "EXPIRED", "CANCELLED"]).optional(),
  ownerId: z.string().uuid().optional(),
  client: z.string().trim().max(200).optional(),
  company: z.string().trim().max(200).optional(),
  dealId: z.string().regex(/^\d{1,30}$/).optional(),
  templateId: z.string().uuid().optional(),
  currency: z.string().length(3).optional(),
  minAmount: z.coerce.number().min(0).optional(),
  maxAmount: z.coerce.number().min(0).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  archived: z.enum(["0", "1"]).optional(),
  sort: z.enum(["createdAt", "updatedAt", "number", "grandTotal", "status", "clientName"]).default("updatedAt"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(20),
});

export type ListFilters = z.infer<typeof listFiltersSchema>;

export function parseListFilters(params: Record<string, string | string[] | undefined>): ListFilters {
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    const value = Array.isArray(v) ? v[0] : v;
    if (value !== undefined && value !== "") flat[k] = value;
  }
  const parsed = listFiltersSchema.safeParse(flat);
  return parsed.success ? parsed.data : listFiltersSchema.parse({});
}

export async function listDocuments(ctx: OrgContext, filters: ListFilters) {
  const scope = await documentViewFilter(ctx);
  const and: Prisma.DocumentWhereInput[] = [scope, filters.archived === "1" ? { archivedAt: { not: null } } : { archivedAt: null }];
  if (filters.type) and.push({ type: filters.type });
  if (filters.status) and.push({ status: filters.status });
  if (filters.ownerId) and.push({ ownerId: filters.ownerId });
  if (filters.dealId) and.push({ hubspotDealId: filters.dealId });
  if (filters.templateId) and.push({ templateId: filters.templateId });
  if (filters.currency) and.push({ currency: filters.currency.toUpperCase() });
  if (filters.client) and.push({ clientName: { contains: filters.client, mode: "insensitive" } });
  if (filters.company) and.push({ clientCompany: { contains: filters.company, mode: "insensitive" } });
  if (filters.minAmount !== undefined) and.push({ grandTotal: { gte: filters.minAmount } });
  if (filters.maxAmount !== undefined) and.push({ grandTotal: { lte: filters.maxAmount } });
  if (filters.from) and.push({ createdAt: { gte: new Date(`${filters.from}T00:00:00Z`) } });
  if (filters.to) and.push({ createdAt: { lte: new Date(`${filters.to}T23:59:59Z`) } });
  if (filters.q) {
    const q = filters.q;
    and.push({
      OR: [
        { number: { contains: q, mode: "insensitive" } },
        { title: { contains: q, mode: "insensitive" } },
        { clientName: { contains: q, mode: "insensitive" } },
        { clientCompany: { contains: q, mode: "insensitive" } },
        { hubspotDealName: { contains: q, mode: "insensitive" } },
      ],
    });
  }
  const where: Prisma.DocumentWhereInput = { AND: and };
  const [total, rows] = await Promise.all([
    prisma.document.count({ where }),
    prisma.document.findMany({
      where,
      include: { owner: { select: { id: true, name: true } }, template: { select: { name: true } } },
      orderBy: [{ [filters.sort]: filters.dir }, { id: "asc" }],
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
  ]);
  return { total, rows, page: filters.page, pageSize: filters.pageSize, pages: Math.max(1, Math.ceil(total / filters.pageSize)) };
}

async function analyticsFilter(ctx: OrgContext): Promise<Prisma.DocumentWhereInput> {
  const view = await documentViewFilter(ctx);
  const scope = analyticsScope(ctx.permissions);
  if (scope === "all") return view;
  if (scope === "team") return { AND: [view, { ownerId: { in: await teamScopeUserIds(ctx) } }] };
  return { AND: [view, { ownerId: ctx.user.id }] };
}

export async function dashboardStats(ctx: OrgContext) {
  const base = await analyticsFilter(ctx);
  const count = (extra: Prisma.DocumentWhereInput) => prisma.document.count({ where: { AND: [base, { archivedAt: null }, extra] } });
  const [drafts, published, awaiting, accepted, signed, expired, totalAccepted, totalSigned] = await Promise.all([
    count({ status: "DRAFT" }),
    count({ status: { in: ["PUBLISHED", "SENT", "VIEWED"] } }),
    count({ type: "CONTRACT", status: { in: ["PUBLISHED", "SENT", "VIEWED", "AWAITING_SIGNATURE"] } }),
    count({ type: "QUOTE", status: "ACCEPTED" }),
    count({ type: "CONTRACT", status: "SIGNED" }),
    count({ status: "EXPIRED" }),
    prisma.document.aggregate({ where: { AND: [base, { archivedAt: null, type: "QUOTE", status: "ACCEPTED" }] }, _sum: { grandTotal: true } }),
    prisma.document.aggregate({ where: { AND: [base, { archivedAt: null, type: "CONTRACT", status: "SIGNED" }] }, _sum: { grandTotal: true } }),
  ]);
  const recent = await prisma.document.findMany({
    where: { AND: [base, { archivedAt: null }] },
    orderBy: { updatedAt: "desc" },
    take: 8,
    include: { owner: { select: { name: true } } },
  });
  return {
    cards: { drafts, published, awaiting, accepted, signed, expired },
    acceptedValue: totalAccepted._sum.grandTotal?.toString() ?? "0",
    signedValue: totalSigned._sum.grandTotal?.toString() ?? "0",
    recent,
  };
}

export function documentAnalytics(doc: {
  viewCount: number;
  uniqueViewCount: number;
  firstViewedAt: Date | null;
  lastViewedAt: Date | null;
  revisionCount: number;
  sendCount: number;
  reminderCount: number;
  firstPublishedAt: Date | null;
  sentAt: Date | null;
  acceptedAt: Date | null;
  signedAt: Date | null;
  rejectedAt: Date | null;
}) {
  const diff = (a: Date | null, b: Date | null) => (a && b ? Math.max(0, a.getTime() - b.getTime()) : null);
  const start = doc.sentAt ?? doc.firstPublishedAt;
  return {
    totalViews: doc.viewCount,
    uniqueViews: doc.uniqueViewCount,
    firstViewedAt: doc.firstViewedAt,
    lastViewedAt: doc.lastViewedAt,
    revisions: doc.revisionCount,
    sends: doc.sendCount,
    reminders: doc.reminderCount,
    publishedAt: doc.firstPublishedAt,
    sentAt: doc.sentAt,
    acceptedAt: doc.acceptedAt,
    signedAt: doc.signedAt,
    rejectedAt: doc.rejectedAt,
    timeToFirstViewMs: diff(doc.firstViewedAt, start),
    timeToCompletionMs: diff(doc.acceptedAt ?? doc.signedAt, start),
  };
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

export type { DocumentStatus, DocumentType };
