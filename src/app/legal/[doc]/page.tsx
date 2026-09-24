import { notFound } from "next/navigation";
import { env } from "@/server/env";

const DOCS = {
  terms: { title: "Terms of Service", versionKey: "TERMS_VERSION" as const },
  privacy: { title: "Privacy Policy", versionKey: "PRIVACY_VERSION" as const },
};

export default async function LegalPage({ params }: { params: Promise<{ doc: string }> }) {
  const { doc } = await params;
  const def = DOCS[doc as keyof typeof DOCS];
  if (!def) notFound();
  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-2xl font-semibold">{def.title}</h1>
      <p className="mt-1 text-sm text-slate-500">Version {env()[def.versionKey]}</p>
      <div className="mt-6 space-y-3 text-sm leading-6 text-slate-700">
        <p>
          This page hosts the {def.title.toLowerCase()} of the DealDocs platform. The operator of this deployment must replace this text with its
          reviewed legal content before going live. When the text changes, increase the version in the environment configuration — every acceptance
          records the version and timestamp.
        </p>
      </div>
    </main>
  );
}
