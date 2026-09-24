import { requireOrgPage } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { InlineAction } from "@/components/forms";
import { PERMISSIONS } from "@/domain/permissions";
import { teamAction } from "@/app/actions/settings";
import { TeamMemberForm, CreateTeamForm } from "./forms";

export const metadata = { title: "Teams" };

export default async function TeamsPage() {
  const ctx = await requireOrgPage(PERMISSIONS.TEAMS_MANAGE);
  const [teams, members] = await Promise.all([
    prisma.team.findMany({ where: { organizationId: ctx.organizationId, archivedAt: null }, include: { members: { include: { membership: { include: { user: true } } } } }, orderBy: { name: "asc" } }),
    prisma.organizationMembership.findMany({ where: { organizationId: ctx.organizationId, status: "ACTIVE" }, include: { user: true } }),
  ]);
  return (
    <>
      <PageHeader title="Teams" description="Managers see and edit the documents of their team members." />
      <div className="space-y-5">
        <Card title="New team"><CreateTeamForm /></Card>
        {teams.length === 0 ? <EmptyState title="No teams yet" /> : null}
        {teams.map((t) => (
          <Card key={t.id} title={t.name} actions={<InlineAction action={teamAction} hidden={{ op: "archive", teamId: t.id }} confirm="Archive this team?">Archive</InlineAction>}>
            <ul className="mb-4 divide-y divide-slate-100 text-sm">
              {t.members.map((m) => (
                <li key={m.id} className="flex items-center justify-between py-2">
                  <span>{m.membership.user.name} {m.isManager ? <span className="text-xs font-medium text-brand-700">Manager</span> : null}</span>
                  <InlineAction action={teamAction} hidden={{ op: "member", teamId: t.id, membershipId: m.membershipId, member: "0" }}>Remove</InlineAction>
                </li>
              ))}
              {t.members.length === 0 ? <li className="py-2 text-slate-500">No members yet.</li> : null}
            </ul>
            <TeamMemberForm teamId={t.id} members={members.filter((m) => !t.members.some((tm) => tm.membershipId === m.id)).map((m) => ({ id: m.id, name: m.user.name }))} />
          </Card>
        ))}
      </div>
    </>
  );
}
