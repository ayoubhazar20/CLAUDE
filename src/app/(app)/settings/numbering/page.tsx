import { requireOrgPage } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { Card, PageHeader } from "@/components/ui";
import { PERMISSIONS } from "@/domain/permissions";
import { DEFAULT_NUMBERING, formatDocumentNumber } from "@/domain/numbering";
import { NumberingForm } from "./form";

export const metadata = { title: "Numbering" };

export default async function NumberingPage() {
  const ctx = await requireOrgPage(PERMISSIONS.ORG_SETTINGS_MANAGE);
  const settings = await prisma.numberingSetting.findMany({ where: { organizationId: ctx.organizationId } });
  const year = new Date().getUTCFullYear();
  return (
    <>
      <PageHeader title="Numbering" description="Numbers are unique within your organization and never reused, even for archived documents." />
      <div className="grid gap-5 lg:grid-cols-2">
        {(["QUOTE", "CONTRACT"] as const).map((type) => {
          const s = settings.find((x) => x.documentType === type) ?? { ...DEFAULT_NUMBERING[type] };
          return (
            <Card key={type} title={type === "QUOTE" ? "Quotes" : "Contracts"}>
              <p className="mb-3 text-sm text-slate-600">Example: <span className="font-mono">{formatDocumentNumber(s, s.startNumber, year)}</span></p>
              <NumberingForm type={type} prefix={s.prefix} includeYear={s.includeYear} startNumber={s.startNumber} padding={s.padding} />
            </Card>
          );
        })}
      </div>
    </>
  );
}
