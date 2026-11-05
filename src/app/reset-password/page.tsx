import Link from "next/link";
import { ResetPasswordForm } from "@/components/forms/AuthForms";

export const metadata = { title: "Choose a new password" };

export default async function Reset({ searchParams }: { searchParams: Promise<{ token?: string; code?: string }> }) {
  const sp = await searchParams;
  const token = sp.token ?? sp.code; // dev auth uses ?token=, Supabase uses ?code=
  return (
    <div className="card" style={{ maxWidth: 480, margin: "0 auto" }}>
      <h1>Choose a new password</h1>
      {token ? <ResetPasswordForm token={token} /> : <p>This link is incomplete. <Link href="/forgot-password">Request a new one</Link>.</p>}
    </div>
  );
}
