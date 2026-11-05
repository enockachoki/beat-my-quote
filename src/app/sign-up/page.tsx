import Link from "next/link";
import { SignUpForm } from "@/components/forms/AuthForms";

export const metadata = { title: "Create an account" };

export default async function SignUp({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const sp = await searchParams;
  return (
    <div className="card" style={{ maxWidth: 520, margin: "0 auto" }}>
      <h1>Create an account</h1>
      <p>It takes a minute. Then upload your quote, photos and a short video.</p>
      <SignUpForm defaultType={sp.type === "builder" ? "builder" : "homeowner"} />
      <p className="small" style={{ marginTop: "1rem" }}>Already have an account? <Link href="/sign-in">Sign in</Link>. Are you a builder? <Link href="/sign-up?type=builder">Apply to join</Link></p>
    </div>
  );
}
