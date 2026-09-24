import { requireOrgPage } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { listAssignableRoles } from "@/server/services/roles";
import { Badge, Card, PageHeader, Table, Td, Th } from "@/components/ui";
import { InlineAction } from "@/components/forms";
import { dateLabel } from "@/lib/format";
import { PERMISSIONS, PERMISSION_LABELS, type Permission } from "@/domain/permissions";
import { memberAction } from "@/app/actions/settings";
import { InviteForm, RoleSelect } from "./forms";

export const metadata = { title: "Users & roles" };

export default async function UsersPage() {
  const ctx = await requireOrgPage(PERMISSIONS.USERS_VIEW);
  const [members, invitations, roles, teams] = await Promise.all([
    prisma.organizationMembership.findMany({ where: { organizationId: ctx.organizationId }, include: { user: true, role: true, teams: { include: { team: true } } }, orderBy: { createdAt: "asc" } }),
    prisma.invitation.findMany({ where: { organizationId: ctx.organizationId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, include: { role: true }, orderBy: { createdAt: "desc" } }),
    listAssignableRoles(ctx.organizationId),
    prisma.team.findMany({ where: { organizationId: ctx.organizationId, archivedAt: null }, orderBy: { name: "asc" } }),
  ]);
  const canManage = ctx.permissions.has(PERMISSIONS.USERS_MANAGE) && !ctx.isSupportView;
  const canRoles = ctx.permissions.has(PERMISSIONS.ROLES_MANAGE) && !ctx.isSupportView;
  const tz = ctx.organization.timezone;
  return (
    <>
      <PageHeader title="Users & roles" description="Invite teammates and control what they can do." />
      <div className="space-y-6">
        {canManage ? (
          <Card title="Invite a user">
            <InviteForm roles={roles.map((r) => ({ id: r.id, name: r.name }))} teams={teams.map((t) => ({ id: t.id, name: t.name }))} />
          </Card>
        ) : null}
        <Table>
          <thead className="bg-slate-50"><tr><Th>User</Th><Th>Role</Th><Th>Teams</Th><Th>Status</Th><Th /></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {members.map((m) => (
              <tr key={m.id}>
                <Td><div className="font-medium">{m.user.name}{m.userId === ctx.user.id ? <span className="ml-1 text-xs text-slate-500">(you)</span> : null}</div><div className="text-xs text-slate-500">{m.user.email}</div></Td>
                <Td>{canRoles && m.userId !== ctx.user.id ? <RoleSelect membershipId={m.id} roleId={m.roleId} roles={roles.map((r) => ({ id: r.id, name: r.name }))} /> : m.role.name}</Td>
                <Td className="text-xs">{m.teams.map((t) => t.team.name + (t.isManager ? " (manager)" : "")).join(", ") || "—"}</Td>
                <Td><Badge tone={m.status === "ACTIVE" ? "green" : m.status === "DISABLED" ? "red" : "gray"}>{m.status.toLowerCase()}</Badge><div className="text-xs text-slate-500">{m.user.lastLoginAt ? `Last login ${dateLabel(m.user.lastLoginAt, tz)}` : "Never logged in"}</div></Td>
                <Td className="text-right">
                  {canManage && m.userId !== ctx.user.id ? (
                    m.status === "ACTIVE" ? (
                      <InlineAction action={memberAction} hidden={{ op: "disable", membershipId: m.id }} variant="danger" confirm={`Disable ${m.user.name}? They will be signed out immediately.`}>Disable</InlineAction>
                    ) : (
                      <InlineAction action={memberAction} hidden={{ op: "enable", membershipId: m.id }}>Enable</InlineAction>
                    )
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        {invitations.length ? (
          <Card title="Pending invitations">
            <ul className="divide-y divide-slate-100 text-sm">
              {invitations.map((i) => (
                <li key={i.id} className="flex items-center justify-between py-2">
                  <span>{i.email} <span className="text-slate-500">· {i.role.name} · expires {dateLabel(i.expiresAt, tz)}</span></span>
                  {canManage ? <InlineAction action={memberAction} hidden={{ op: "revokeInvite", invitationId: i.id }}>Revoke</InlineAction> : null}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
        <Card title="Roles & permissions">
          <p className="mb-3 text-sm text-slate-600">Access is based on permissions attached to roles — custom roles can be added without code changes.</p>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead>
                <tr><th className="p-2 text-left">Permission</th>{roles.map((r) => <th key={r.id} className="p-2 text-center">{r.name}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(Object.keys(PERMISSION_LABELS) as Permission[]).map((p) => (
                  <tr key={p}>
                    <td className="p-2">{PERMISSION_LABELS[p]}</td>
                    {roles.map((r) => <td key={r.id} className="p-2 text-center">{r.permissions.some((rp) => rp.permission === p) ? <span aria-label="Granted" className="text-emerald-600">●</span> : <span aria-label="Not granted" className="text-slate-300">○</span>}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}
