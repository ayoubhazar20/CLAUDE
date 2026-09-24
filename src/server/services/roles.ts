import type { Role } from "@prisma/client";
import { prisma, type Tx } from "../db";
import { SYSTEM_ROLES, type SystemRoleKey } from "@/domain/permissions";

/**
 * System roles are shared rows (organizationId = null). Their permission sets are
 * data, so organization-specific custom roles can be introduced later.
 */
export async function ensureSystemRoles(tx: Tx = prisma): Promise<Record<SystemRoleKey, Role>> {
  const result = {} as Record<SystemRoleKey, Role>;
  for (const [key, def] of Object.entries(SYSTEM_ROLES) as [SystemRoleKey, (typeof SYSTEM_ROLES)[SystemRoleKey]][]) {
    let role = await tx.role.findFirst({ where: { organizationId: null, key } });
    if (!role) {
      role = await tx.role.create({ data: { key, name: def.name, description: def.description, isSystem: true, rank: def.rank } });
    } else if (role.name !== def.name || role.rank !== def.rank) {
      role = await tx.role.update({ where: { id: role.id }, data: { name: def.name, rank: def.rank, description: def.description } });
    }
    const existing = new Set((await tx.rolePermission.findMany({ where: { roleId: role.id } })).map((p) => p.permission));
    const wanted = new Set<string>(def.permissions);
    const toAdd = [...wanted].filter((p) => !existing.has(p));
    const toRemove = [...existing].filter((p) => !wanted.has(p));
    if (toAdd.length) await tx.rolePermission.createMany({ data: toAdd.map((permission) => ({ roleId: role!.id, permission })), skipDuplicates: true });
    if (toRemove.length) await tx.rolePermission.deleteMany({ where: { roleId: role.id, permission: { in: toRemove } } });
    result[key] = role;
  }
  return result;
}

let cachedRoles: Record<SystemRoleKey, Role> | null = null;
/** Test hook: forget cached role rows (e.g. after truncating the database). */
export function clearRoleCache() {
  cachedRoles = null;
}
export async function systemRole(key: SystemRoleKey, tx: Tx = prisma): Promise<Role> {
  if (!cachedRoles) cachedRoles = await ensureSystemRoles(tx);
  return cachedRoles[key];
}

/** Roles assignable inside an organization (system + organization custom roles). */
export async function listAssignableRoles(organizationId: string) {
  await systemRole("admin");
  return prisma.role.findMany({
    where: { OR: [{ organizationId: null }, { organizationId }] },
    include: { permissions: true },
    orderBy: { rank: "asc" },
  });
}
