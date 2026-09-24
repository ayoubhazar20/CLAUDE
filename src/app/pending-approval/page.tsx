import { redirect } from "next/navigation";
import { prisma } from "@/server/db";
import { requireUserPage } from "@/server/auth/context";
import { logoutAction } from "@/app/actions/auth";
import { Alert, Button } from "@/components/ui";

export const metadata = { title: "Pending approval" };

export default async function PendingApprovalPage() {
  const user = await requireUserPage();
  const membership = await prisma.organizationMembership.findFirst({ where: { userId: user.id }, include: { organization: true } });
  if (!membership) redirect("/register/company");
  const org = membership.organization;
  if (org.status === "ACTIVE") redirect("/dashboard");
  return (
    <main className="mx-auto max-w-xl px-4 py-16">
      <div className="rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        {org.status === "REJECTED" ? (
          <>
            <h1 className="text-xl font-semibold">Registration not approved</h1>
            <div className="mt-4"><Alert tone="error">{org.rejectionReason ?? "Your registration could not be approved. Please contact support."}</Alert></div>
          </>
        ) : org.status === "SUSPENDED" ? (
          <>
            <h1 className="text-xl font-semibold">Account suspended</h1>
            <div className="mt-4"><Alert tone="warning">{org.suspensionReason ?? "This organization is suspended. Please contact support."}</Alert></div>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold">Thanks — {org.name} is under review</h1>
            <p className="mt-2 text-sm text-slate-600">
              Our team reviews every new company before activation. You will receive an email at <strong>{user.email}</strong> as soon as your account is approved.
            </p>
          </>
        )}
        <form action={logoutAction} className="mt-6">
          <Button variant="secondary" type="submit">Sign out</Button>
        </form>
      </div>
    </main>
  );
}
