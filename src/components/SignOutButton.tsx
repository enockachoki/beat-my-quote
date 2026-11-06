"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./api";

export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  return (
    <button
      type="button"
      className="btn btn-secondary"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await api("/api/auth/sign-out", { method: "POST", body: {} });
        router.push("/");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
