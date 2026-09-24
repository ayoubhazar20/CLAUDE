import { ButtonLink } from "@/components/ui";

export const metadata = { title: "Unauthorized" };

export default function UnauthorizedPage() {
  return (
    <main className="mx-auto max-w-lg px-4 py-24 text-center">
      <h1 className="text-2xl font-semibold">You do not have access to this page</h1>
      <p className="mt-2 text-sm text-slate-600">Ask a Company Admin if you believe you should have access.</p>
      <div className="mt-6"><ButtonLink href="/dashboard">Back to dashboard</ButtonLink></div>
    </main>
  );
}
