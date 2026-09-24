import { prisma } from "@/server/db";
import { Badge, Button, Input, PageHeader, Table, Td, Th } from "@/components/ui";
import { InlineAction } from "@/components/forms";
import { dateLabel } from "@/lib/format";
import { userStatusAction } from "@/app/actions/admin";

export const metadata = { title: "Users" };

export default async function AdminUsers({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const q = (await searchParams).q ?? "";
  const users = await prisma.user.findMany({
    where: q ? { OR: [{ email: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }] } : {},
    include: { memberships: { include: { organization: { select: { name: true } } } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return (
    <>
      <PageHeader title="Users" />
      <form method="get" className="mb-4 flex max-w-md gap-2"><Input name="q" defaultValue={q} placeholder="Search name or email" aria-label="Search users" /><Button type="submit" variant="secondary">Search</Button></form>
      <Table>
        <thead className="bg-slate-50"><tr><Th>User</Th><Th>Organizations</Th><Th>Status</Th><Th>Last login</Th><Th /></tr></thead>
        <tbody className="divide-y divide-slate-100">
          {users.map((u) => (
            <tr key={u.id}>
              <Td>{u.name}{u.isPlatformAdmin ? <span className="ml-1"><Badge tone="purple">Platform admin</Badge></span> : null}<div className="text-xs text-slate-500">{u.email}{u.emailVerifiedAt ? "" : " · unverified"}</div></Td>
              <Td className="text-xs">{u.memberships.map((m) => m.organization.name).join(", ") || "—"}</Td>
              <Td><Badge tone={u.status === "ACTIVE" ? "green" : "red"}>{u.status.toLowerCase()}</Badge></Td>
              <Td className="text-xs">{dateLabel(u.lastLoginAt)}</Td>
              <Td className="text-right">
                {u.status === "ACTIVE" ? <InlineAction action={userStatusAction} hidden={{ userId: u.id, status: "SUSPENDED" }} variant="danger" confirm={`Suspend ${u.email}?`}>Suspend</InlineAction> : <InlineAction action={userStatusAction} hidden={{ userId: u.id, status: "ACTIVE" }}>Reactivate</InlineAction>}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}
