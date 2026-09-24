import { prisma } from "@/server/db";
import { Card, PageHeader } from "@/components/ui";
import { PlanEditForm } from "./form";

export const metadata = { title: "Plans" };

export default async function AdminPlans() {
  const plans = await prisma.plan.findMany({ orderBy: { sortOrder: "asc" }, include: { _count: { select: { subscriptions: { where: { status: { in: ["ACTIVE", "TRIALING"] } } } } } } });
  return (
    <>
      <PageHeader title="Plans & limits" description="Billing is not active in V1; limits are enforced from these values. Leave a limit empty for unlimited." />
      <div className="grid gap-5 md:grid-cols-2">
        {plans.map((p) => (
          <Card key={p.id} title={`${p.name} (${p.key})`} actions={<span className="text-xs text-slate-500">{p._count.subscriptions} organizations{p.isDefault ? " · default" : ""}</span>}>
            <PlanEditForm plan={{ id: p.id, name: p.name, maxUsers: p.maxUsers, maxDocumentsPerMonth: p.maxDocumentsPerMonth, maxStorageMb: p.maxStorageMb, isActive: p.isActive }} />
            <p className="mt-2 text-xs text-slate-500">Features: {p.features.join(", ")}</p>
          </Card>
        ))}
      </div>
    </>
  );
}
