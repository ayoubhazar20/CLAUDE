import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/context";
import { verifyEmail } from "@/server/services/auth";
import { requestMeta } from "@/server/request";
import { Alert, ButtonLink } from "@/components/ui";
import { ResendVerification } from "./resend";

export const metadata = { title: "Verify your email" };

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  if (token) {
    const user = await verifyEmail(token, await requestMeta());
    if (!user) {
      return (
        <>
          <h1 className="mb-3 text-xl font-semibold">Link expired</h1>
          <Alert tone="error">This verification link is invalid or has expired.</Alert>
          <div className="mt-6"><ButtonLink href="/login">Sign in to request a new link</ButtonLink></div>
        </>
      );
    }
    return (
      <>
        <h1 className="mb-3 text-xl font-semibold">Email verified</h1>
        <Alert tone="success">Thanks — your email address is confirmed.</Alert>
        <div className="mt-6"><ButtonLink href="/register/company">Continue</ButtonLink></div>
      </>
    );
  }
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.emailVerified) redirect("/dashboard");
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">Check your inbox</h1>
      <p className="mb-6 text-sm text-slate-600">
        We sent a verification link to <strong>{user.email}</strong>. Click it to continue setting up DealDocs.
      </p>
      <ResendVerification />
    </>
  );
}
