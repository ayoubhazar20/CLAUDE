import Link from "next/link";
import { RegisterForm } from "./register-form";

export const metadata = { title: "Create your account" };

export default function RegisterPage() {
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">Create your account</h1>
      <p className="mb-6 text-sm text-slate-600">Start with your personal account. You will add your company in the next step.</p>
      <RegisterForm />
      <p className="mt-6 text-center text-sm text-slate-600">
        Already have an account? <Link href="/login" className="text-brand-700 hover:underline">Sign in</Link>
      </p>
    </>
  );
}
