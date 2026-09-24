import { requireOrgPage } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { Card, PageHeader } from "@/components/ui";
import { PERMISSIONS } from "@/domain/permissions";
import { BrandingForm } from "./branding-form";

export const metadata = { title: "Branding" };

export default async function BrandingPage() {
  const ctx = await requireOrgPage(PERMISSIONS.ORG_SETTINGS_MANAGE);
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } });
  return (
    <>
      <PageHeader title="Branding" description="Your logo and brand color appear on documents, the client page and emails." />
      <Card>
        <BrandingForm brandColor={org.brandColor} logoFileId={org.logoFileId} />
      </Card>
    </>
  );
}
