import Link from "next/link";
import { SignInForm } from "@/components/forms/AuthForms";

export const metadata = { title: "Sign in" };

export default async function SignIn({ searchParams }: { searchParams: Promise<{ next?: string; expired?: string }> }) {
  const sp = await searchParams;
  return (
    <div className="card" style={{ maxWidth: 480, margin: "0 auto" }}>
      <h1>Sign in</h1>
      <SignInForm next={sp.next ?? null} expired={sp.expired === "1"} />
      <p className="small" style={{ marginTop: "1rem" }}>New here? <Link href="/sign-up">Create an account</Link></p>
    </div>
  );
}
