import { requireOrgPage } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { Card, DescriptionList, PageHeader } from "@/components/ui";
import { PERMISSIONS } from "@/domain/permissions";
import { ProfileForm } from "./profile-form";

export const metadata = { title: "Company profile" };

export default async function ProfilePage() {
  const ctx = await requireOrgPage();
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } });
  const canManage = ctx.permissions.has(PERMISSIONS.ORG_SETTINGS_MANAGE) && !ctx.isSupportView;
  return (
    <>
      <PageHeader title="Company profile" description="Shown on your documents." />
      <Card>
        {canManage ? (
          <ProfileForm defaults={org} />
        ) : (
          <DescriptionList
            items={[
              { label: "Company", value: org.name },
              { label: "Legal name", value: org.legalName },
              { label: "Address", value: [org.addressLine1, org.city, org.country].filter(Boolean).join(", ") },
              { label: "Currency", value: org.defaultCurrency },
              { label: "Timezone", value: org.timezone },
              { label: "VAT", value: org.vatNumber },
            ]}
          />
        )}
      </Card>
    </>
  );
}
