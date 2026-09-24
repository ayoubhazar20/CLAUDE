import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrgPage } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { getIntegration, isConfigured } from "@/server/integrations/config";
import { listAssignableRoles } from "@/server/services/roles";
import { ONBOARDING_STEPS, type OnboardingStep } from "@/server/services/organizations";
import { Alert, ButtonLink, cn } from "@/components/ui";
import { PERMISSIONS } from "@/domain/permissions";
import { ProfileForm } from "@/app/(app)/settings/profile-form";
import { BrandingForm } from "@/app/(app)/settings/branding/branding-form";
import { InviteForm } from "@/app/(app)/settings/users/forms";
import { StepActions, CurrencyForm } from "./step-actions";

export const metadata = { title: "Welcome to DealDocs" };

const TITLES: Record<OnboardingStep, string> = {
  profile: "Company profile",
  branding: "Branding",
  hubspot: "HubSpot via Zapier",
  currency: "Default currency",
  pipeline: "Pipeline automation",
  templates: "Templates",
  team: "Invite your team",
  ready: "Ready",
};
const OPTIONAL: OnboardingStep[] = ["branding", "hubspot", "pipeline", "templates", "team"];

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ step?: string }> }) {
  const ctx = await requireOrgPage(PERMISSIONS.ORG_SETTINGS_MANAGE);
  if (ctx.isSupportView) redirect("/dashboard");
  const requested = (await searchParams).step as OnboardingStep | undefined;
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } });
  const state = (org.onboardingState ?? {}) as Record<string, string>;
  const step: OnboardingStep = requested && ONBOARDING_STEPS.includes(requested) ? requested : ONBOARDING_STEPS.find((s) => !state[s]) ?? "ready";
  const index = ONBOARDING_STEPS.indexOf(step);

  let body: React.ReactNode = null;
  if (step === "profile") body = <ProfileForm defaults={org} onboardingStep="profile" />;
  if (step === "branding") body = <BrandingForm brandColor={org.brandColor} logoFileId={org.logoFileId} onboarding />;
  if (step === "hubspot") {
    const integration = await getIntegration(ctx.organizationId);
    body = isConfigured(integration) ? (
      <Alert tone="success" title="HubSpot sync configured">Documents are mirrored to HubSpot through your Zapier webhook.</Alert>
    ) : (
      <div className="space-y-3 text-sm text-slate-600">
        <p>DealDocs connects to HubSpot through Zapier: each quote or contract becomes a HubSpot custom object record associated to its deal, and deal data (contacts, company, line items) is sent back to DealDocs.</p>
        <p>Enter your HubSpot custom object type ID and Zapier webhook URL, and generate the integration secret for Zapier.</p>
        <ButtonLink href="/settings/integrations/zapier">Configure HubSpot via Zapier</ButtonLink>
      </div>
    );
  }
  if (step === "currency") body = <CurrencyForm current={org.defaultCurrency} />;
  if (step === "pipeline") {
    body = (
      <div className="space-y-3 text-sm text-slate-600">
        <p>Deal stages are moved outside DealDocs, so your HubSpot pipelines stay under your control. DealDocs sends events such as <code>DOCUMENT_SIGNED</code> and suggested deal properties such as <code>latest_contract_status</code>.</p>
        <p>Either add a “Update deal stage” step in your Zap, or create a HubSpot workflow — for example: when <code>latest_contract_status</code> is <code>signed</code>, move the deal to Closed Won.</p>
        <ButtonLink variant="secondary" href="/settings/integrations/zapier">Open integration settings</ButtonLink>
      </div>
    );
  }
  if (step === "templates") {
    const templates = await prisma.template.findMany({ where: { organizationId: ctx.organizationId, status: "ACTIVE" }, orderBy: { name: "asc" } });
    body = (
      <div className="space-y-3 text-sm text-slate-600">
        <p>We created starter templates for you. Customize them or create your own.</p>
        <ul className="list-disc pl-5">{templates.map((t) => <li key={t.id}><Link className="text-brand-700 underline" href={`/templates/${t.id}`}>{t.name}</Link> ({t.documentType.toLowerCase()})</li>)}</ul>
        <ButtonLink variant="secondary" href="/templates">Open templates</ButtonLink>
      </div>
    );
  }
  if (step === "team") {
    const [roles, teams] = await Promise.all([listAssignableRoles(ctx.organizationId), prisma.team.findMany({ where: { organizationId: ctx.organizationId, archivedAt: null } })]);
    body = <InviteForm roles={roles.map((r) => ({ id: r.id, name: r.name }))} teams={teams.map((t) => ({ id: t.id, name: t.name }))} />;
  }
  if (step === "ready") {
    body = (
      <div className="space-y-3 text-sm text-slate-700">
        <p className="text-lg font-semibold">You are all set!</p>
        <p>Open a deal in HubSpot and use the DealDocs card, or create your first document here.</p>
      </div>
    );
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Welcome to DealDocs</h1>
      <p className="mt-1 text-sm text-slate-600">A few steps to get {org.name} ready. You can skip optional steps and come back later from Settings.</p>
      <div className="mt-6 grid gap-6 md:grid-cols-[220px_1fr]">
        <ol className="space-y-1" aria-label="Setup steps">
          {ONBOARDING_STEPS.map((s, i) => (
            <li key={s}>
              <Link href={`/onboarding?step=${s}`} aria-current={s === step ? "step" : undefined} className={cn("flex items-center gap-2 rounded-md px-3 py-1.5 text-sm", s === step ? "bg-white font-semibold shadow-sm" : "text-slate-600 hover:bg-white")}>
                <span className={cn("flex h-5 w-5 items-center justify-center rounded-full text-[11px]", state[s] === "done" ? "bg-emerald-600 text-white" : state[s] === "skipped" ? "bg-slate-300 text-white" : "border border-slate-300")}>{state[s] === "done" ? "✓" : i + 1}</span>
                Step {i + 1} — {TITLES[s]}
              </Link>
            </li>
          ))}
        </ol>
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm" aria-labelledby="step-title">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Step {index + 1} of {ONBOARDING_STEPS.length}</p>
          <h2 id="step-title" className="mb-4 text-xl font-semibold">{TITLES[step]}</h2>
          {body}
          <StepActions step={step} optional={OPTIONAL.includes(step)} />
        </section>
      </div>
    </main>
  );
}
