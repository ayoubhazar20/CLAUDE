import Link from "next/link";
import { LoginForm } from "./login-form";
import { Alert } from "@/components/ui";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; reset?: string }> }) {
  const sp = await searchParams;
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">Sign in</h1>
      <p className="mb-6 text-sm text-slate-600">Welcome back to DealDocs.</p>
      {sp.reset ? (
        <div className="mb-4">
          <Alert tone="success">Your password was reset. You can sign in now.</Alert>
        </div>
      ) : null}
      <LoginForm next={sp.next ?? "/dashboard"} />
      <div className="mt-6 flex justify-between text-sm">
        <Link href="/forgot-password" className="text-brand-700 hover:underline">Forgot password?</Link>
        <Link href="/register" className="text-brand-700 hover:underline">Create an account</Link>
      </div>
    </>
  );
}
