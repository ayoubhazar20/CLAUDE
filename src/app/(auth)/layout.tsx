import Link from "next/link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <Link href="/" className="mb-8 text-2xl font-bold tracking-tight text-slate-900">
        Deal<span className="text-brand-600">Docs</span>
      </Link>
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">{children}</div>
      <p className="mt-6 text-xs text-slate-500">
        <Link href="/legal/terms" className="hover:underline">Terms</Link> · <Link href="/legal/privacy" className="hover:underline">Privacy</Link>
      </p>
    </main>
  );
}
