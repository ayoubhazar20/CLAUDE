import { redirect } from "next/navigation";
import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { requireUserPage } from "@/server/auth/context";
import { CompanyForm } from "./company-form";

export const metadata = { title: "Your company" };

export default async function CompanyPage() {
  const user = await requireUserPage();
  if (!user.emailVerified) redirect("/verify-email");
  const membership = await prisma.organizationMembership.findFirst({ where: { userId: user.id }, include: { organization: true } });
  if (membership) redirect(membership.organization.status === "ACTIVE" ? "/dashboard" : "/pending-approval");
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Tell us about your company</h1>
      <p className="mt-1 text-sm text-slate-600">This information appears on your quotes and contracts. Your account will be reviewed before activation.</p>
      <div className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <CompanyForm termsVersion={env().TERMS_VERSION} privacyVersion={env().PRIVACY_VERSION} />
      </div>
    </main>
  );
}
