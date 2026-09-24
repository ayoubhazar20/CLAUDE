import { ButtonLink } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg py-20 text-center">
      <h1 className="text-xl font-semibold">Not found</h1>
      <p className="mt-2 text-sm text-slate-600">This item does not exist or you do not have access to it.</p>
      <ButtonLink href="/dashboard" className="mt-6">Back to dashboard</ButtonLink>
    </div>
  );
}
