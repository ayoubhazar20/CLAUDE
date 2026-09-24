import { z } from "zod";
import { prisma } from "../db";
import { appUrl } from "../env";
import { audit } from "../audit";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { hmac, randomToken } from "../security/crypto";
import { hashPassword, passwordPolicyError } from "../security/password";
import type { RequestMeta } from "../request";
import { queueEmail } from "../email/service";
import { renderEmailLayout, textToEmailHtml } from "../email/layout";
import { assertPermission, assertWritable, type OrgContext } from "../auth/context";
import { revokeAllUserSessions } from "../auth/session";
import { emailSchema } from "./auth";
import { assertWithinLimit } from "./billing";
import { PERMISSIONS } from "@/domain/permissions";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function resolveAssignableRole(ctx: OrgContext, roleId: string) {
  const role = await prisma.role.findFirst({ where: { id: roleId, OR: [{ organizationId: null }, { organizationId: ctx.organizationId }] } });
  if (!role) throw new ValidationError("Unknown role");
  return role;
}

async function assertNotLastAdmin(organizationId: string, membershipId: string) {
  const membership = await prisma.organizationMembership.findUnique({ where: { id: membershipId }, include: { role: true } });
  if (membership?.role.key !== "admin" || membership.status !== "ACTIVE") return;
  const admins = await prisma.organizationMembership.count({ where: { organizationId, status: "ACTIVE", role: { key: "admin" } } });
  if (admins <= 1) throw new ConflictError("An organization must keep at least one active Company Admin.");
}

export const inviteSchema = z.object({
  email: emailSchema,
  roleId: z.string().uuid(),
  teamId: z.string().uuid().optional().nullable(),
});

export async function inviteUser(ctx: OrgContext, input: z.input<typeof inviteSchema>) {
  assertWritable(ctx);
  assertPermission(ctx, PERMISSIONS.USERS_MANAGE);
  const data = inviteSchema.parse(input);
  const role = await resolveAssignableRole(ctx, data.roleId);
  await assertWithinLimit(ctx.organizationId, "users");
  if (data.teamId) {
    const team = await prisma.team.findFirst({ where: { id: data.teamId, organizationId: ctx.organizationId } });
    if (!team) throw new ValidationError("Unknown team");
  }
  const existingUser = await prisma.user.findUnique({ where: { email: data.email } });
  if (existingUser) {
    const membership = await prisma.organizationMembership.findUnique({ where: { organizationId_userId: { organizationId: ctx.organizationId, userId: existingUser.id } } });
    if (membership) throw new ConflictError("This user is already a member of your organization.");
    const other = await prisma.organizationMembership.count({ where: { userId: existingUser.id, status: "ACTIVE" } });
    if (other > 0) throw new ConflictError("This email already belongs to another organization.");
  }
  await prisma.invitation.updateMany({
    where: { organizationId: ctx.organizationId, email: data.email, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  const token = randomToken(32);
  const invitation = await prisma.invitation.create({
    data: {
      organizationId: ctx.organizationId,
      email: data.email,
      roleId: role.id,
      teamId: data.teamId ?? null,
      tokenHash: hmac(token, "invitation"),
      invitedById: ctx.user.id,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
  });
  await queueEmail({
    organizationId: ctx.organizationId,
    kind: "INVITATION",
    to: [data.email],
    subject: `${ctx.user.name} invited you to ${ctx.organization.name} on DealDocs`,
    html: renderEmailLayout({
      brandName: ctx.organization.name,
      brandColor: ctx.organization.brandColor,
      bodyHtml: textToEmailHtml(`${ctx.user.name} invited you to join ${ctx.organization.name} on DealDocs as ${role.name}.\n\nThis invitation expires in 7 days.`),
      action: { label: "Accept invitation", url: appUrl(`/invite/${encodeURIComponent(token)}`) },
    }),
  });
  await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "USER_INVITED", entityType: "Invitation", entityId: invitation.id, ip: ctx.meta.ip, userAgent: ctx.meta.userAgent, newValue: { email: data.email, role: role.key } });
  return invitation;
}

export async function revokeInvitation(ctx: OrgContext, invitationId: string) {
  assertWritable(ctx);
  assertPermission(ctx, PERMISSIONS.USERS_MANAGE);
  const inv = await prisma.invitation.findFirst({ where: { id: invitationId, organizationId: ctx.organizationId } });
  if (!inv) throw new NotFoundError("Invitation");
  await prisma.invitation.update({ where: { id: inv.id }, data: { revokedAt: new Date() } });
  await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "USER_INVITATION_REVOKED", entityType: "Invitation", entityId: inv.id, newValue: { email: inv.email } });
}

export async function findInvitation(token: string) {
  if (!token || token.length > 200) return null;
  const inv = await prisma.invitation.findUnique({ where: { tokenHash: hmac(token, "invitation") }, include: { organization: true, role: true } });
  if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt < new Date()) return null;
  return inv;
}

export async function acceptInvitation(token: string, input: { name?: string; password?: string; currentUserId?: string | null }, meta: RequestMeta) {
  const inv = await findInvitation(token);
  if (!inv) throw new AppError("This invitation is invalid or has expired.", 400, "INVALID_INVITATION");
  if (inv.organization.status !== "ACTIVE") throw new AppError("This organization is not active.", 403, "ORG_INACTIVE");
  let user = await prisma.user.findUnique({ where: { email: inv.email } });
  if (user) {
    if (input.currentUserId !== user.id) throw new AppError("Sign in with the invited email address to accept this invitation.", 403, "WRONG_ACCOUNT");
  } else {
    const name = (input.name ?? "").trim();
    if (name.length < 2) throw new ValidationError("Please enter your name", { fieldErrors: { name: ["Please enter your name"] } });
    const policy = passwordPolicyError(input.password ?? "");
    if (policy) throw new ValidationError(policy, { fieldErrors: { password: [policy] } });
    user = await prisma.user.create({
      data: { email: inv.email, name, passwordHash: await hashPassword(input.password!), emailVerifiedAt: new Date() },
    });
  }
  const userId = user.id;
  await prisma.$transaction(async (tx) => {
    const membership = await tx.organizationMembership.upsert({
      where: { organizationId_userId: { organizationId: inv.organizationId, userId } },
      create: { organizationId: inv.organizationId, userId, roleId: inv.roleId, status: "ACTIVE", invitedById: inv.invitedById, joinedAt: new Date() },
      update: { status: "ACTIVE", roleId: inv.roleId, joinedAt: new Date(), disabledAt: null },
    });
    if (inv.teamId) {
      await tx.teamMembership.upsert({
        where: { teamId_membershipId: { teamId: inv.teamId, membershipId: membership.id } },
        create: { organizationId: inv.organizationId, teamId: inv.teamId, membershipId: membership.id },
        update: {},
      });
    }
    await tx.invitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } });
    await audit({ organizationId: inv.organizationId, userId, action: "USER_INVITATION_ACCEPTED", entityType: "Invitation", entityId: inv.id, ip: meta.ip, userAgent: meta.userAgent }, tx);
  });
  return { user, organizationId: inv.organizationId };
}

export async function setMembershipStatus(ctx: OrgContext, membershipId: string, enabled: boolean) {
  assertWritable(ctx);
  assertPermission(ctx, PERMISSIONS.USERS_MANAGE);
  const membership = await prisma.organizationMembership.findFirst({ where: { id: membershipId, organizationId: ctx.organizationId }, include: { user: true } });
  if (!membership) throw new NotFoundError("User");
  if (membership.userId === ctx.user.id) throw new ForbiddenError("You cannot disable your own account.");
  if (!enabled) await assertNotLastAdmin(ctx.organizationId, membership.id);
  if (enabled) await assertWithinLimit(ctx.organizationId, "users");
  await prisma.organizationMembership.update({
    where: { id: membership.id },
    data: { status: enabled ? "ACTIVE" : "DISABLED", disabledAt: enabled ? null : new Date() },
  });
  if (!enabled) await revokeAllUserSessions(membership.userId);
  await audit({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    action: enabled ? "USER_ENABLED" : "USER_DISABLED",
    entityType: "User",
    entityId: membership.userId,
    ip: ctx.meta.ip,
    userAgent: ctx.meta.userAgent,
    metadata: { email: membership.user.email },
  });
}

export async function changeMemberRole(ctx: OrgContext, membershipId: string, roleId: string) {
  assertWritable(ctx);
  assertPermission(ctx, PERMISSIONS.ROLES_MANAGE);
  const membership = await prisma.organizationMembership.findFirst({ where: { id: membershipId, organizationId: ctx.organizationId }, include: { role: true } });
  if (!membership) throw new NotFoundError("User");
  const role = await resolveAssignableRole(ctx, roleId);
  if (membership.role.key === "admin" && role.key !== "admin") await assertNotLastAdmin(ctx.organizationId, membership.id);
  await prisma.organizationMembership.update({ where: { id: membership.id }, data: { roleId: role.id } });
  await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "USER_ROLE_CHANGED", entityType: "User", entityId: membership.userId, previousValue: { role: membership.role.key }, newValue: { role: role.key } });
}

// ───────────────────────── Teams ─────────────────────────

export async function createTeam(ctx: OrgContext, name: string) {
  assertWritable(ctx);
  assertPermission(ctx, PERMISSIONS.TEAMS_MANAGE);
  const clean = z.string().trim().min(2).max(80).parse(name);
  const exists = await prisma.team.findFirst({ where: { organizationId: ctx.organizationId, name: clean } });
  if (exists) throw new ConflictError("A team with this name already exists.");
  const team = await prisma.team.create({ data: { organizationId: ctx.organizationId, name: clean } });
  await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "TEAM_CREATED", entityType: "Team", entityId: team.id, newValue: { name: clean } });
  return team;
}

export async function setTeamMember(ctx: OrgContext, teamId: string, membershipId: string, member: boolean, isManager = false) {
  assertWritable(ctx);
  assertPermission(ctx, PERMISSIONS.TEAMS_MANAGE);
  const team = await prisma.team.findFirst({ where: { id: teamId, organizationId: ctx.organizationId } });
  const membership = await prisma.organizationMembership.findFirst({ where: { id: membershipId, organizationId: ctx.organizationId } });
  if (!team || !membership) throw new NotFoundError("Team member");
  if (member) {
    await prisma.teamMembership.upsert({
      where: { teamId_membershipId: { teamId, membershipId } },
      create: { organizationId: ctx.organizationId, teamId, membershipId, isManager },
      update: { isManager },
    });
  } else {
    await prisma.teamMembership.deleteMany({ where: { teamId, membershipId, organizationId: ctx.organizationId } });
  }
  await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "TEAM_UPDATED", entityType: "Team", entityId: team.id, metadata: { membershipId, member, isManager } });
}

export async function archiveTeam(ctx: OrgContext, teamId: string) {
  assertWritable(ctx);
  assertPermission(ctx, PERMISSIONS.TEAMS_MANAGE);
  const team = await prisma.team.findFirst({ where: { id: teamId, organizationId: ctx.organizationId } });
  if (!team) throw new NotFoundError("Team");
  await prisma.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
  await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "TEAM_ARCHIVED", entityType: "Team", entityId: team.id });
}

/** User ids visible under "team" scope: the user plus members of every team they belong to. */
export async function teamScopeUserIds(ctx: OrgContext): Promise<string[]> {
  if (!ctx.membershipId) return [ctx.user.id];
  const myTeams = await prisma.teamMembership.findMany({ where: { membershipId: ctx.membershipId, organizationId: ctx.organizationId }, select: { teamId: true } });
  if (!myTeams.length) return [ctx.user.id];
  const members = await prisma.teamMembership.findMany({
    where: { teamId: { in: myTeams.map((t) => t.teamId) }, organizationId: ctx.organizationId },
    select: { membership: { select: { userId: true } } },
  });
  return [...new Set([ctx.user.id, ...members.map((m) => m.membership.userId)])];
}
