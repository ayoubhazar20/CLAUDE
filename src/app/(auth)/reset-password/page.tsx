import { ResetForm } from "./reset-form";
import { Alert } from "@/components/ui";

export const metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  if (!token) return <Alert tone="error">This reset link is invalid.</Alert>;
  return (
    <>
      <h1 className="mb-6 text-xl font-semibold">Choose a new password</h1>
      <ResetForm token={token} />
    </>
  );
}
