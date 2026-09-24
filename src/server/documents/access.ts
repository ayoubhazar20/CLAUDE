import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { ForbiddenError, NotFoundError } from "../errors";
import type { OrgContext } from "../auth/context";
import { teamScopeUserIds } from "../services/members";
import { editScope, viewScope, type AccessScope } from "@/domain/permissions";

/**
 * Tenant isolation + record-level access for documents.
 * Every query is constrained by the organization from the server-side context
 * (never from client input); inaccessible documents behave as "not found" to
 * avoid leaking their existence (IDOR protection).
 */
async function scopeFilter(ctx: OrgContext, scope: AccessScope): Promise<Prisma.DocumentWhereInput | null> {
  switch (scope) {
    case "all":
      return { organizationId: ctx.organizationId };
    case "team":
      return { organizationId: ctx.organizationId, ownerId: { in: await teamScopeUserIds(ctx) } };
    case "own":
      return { organizationId: ctx.organizationId, ownerId: ctx.user.id };
    case "none":
      return null;
  }
}

export async function documentViewFilter(ctx: OrgContext): Promise<Prisma.DocumentWhereInput> {
  const filter = await scopeFilter(ctx, viewScope(ctx.permissions));
  // Impossible id → empty result set, still tenant-scoped.
  return filter ?? { organizationId: ctx.organizationId, id: "00000000-0000-0000-0000-000000000000" };
}

export async function loadDocumentForView<T extends Prisma.DocumentInclude>(ctx: OrgContext, id: string, include?: T) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError("Document");
  const filter = await documentViewFilter(ctx);
  const doc = await prisma.document.findFirst({ where: { AND: [filter, { id }] }, include });
  if (!doc) throw new NotFoundError("Document");
  return doc as Prisma.DocumentGetPayload<{ include: T }>;
}

export async function canEditDocument(ctx: OrgContext, doc: { organizationId: string; ownerId: string }): Promise<boolean> {
  if (ctx.isSupportView || doc.organizationId !== ctx.organizationId) return false;
  const scope = editScope(ctx.permissions);
  if (scope === "all") return true;
  if (scope === "own") return doc.ownerId === ctx.user.id;
  if (scope === "team") return (await teamScopeUserIds(ctx)).includes(doc.ownerId);
  return false;
}

export async function loadDocumentForEdit<T extends Prisma.DocumentInclude>(ctx: OrgContext, id: string, include?: T) {
  const doc = await loadDocumentForView(ctx, id, include);
  if (!(await canEditDocument(ctx, doc))) throw new ForbiddenError("You cannot edit this document");
  return doc;
}
