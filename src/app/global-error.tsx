"use client";

import { useEffect } from "react";
import { reportClientError } from "@/components/api";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    reportClientError(error.message, { digest: error.digest });
  }, [error]);
  return (
    <html lang="en-GB">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: 24, background: "#f3f4ef", color: "#17222e" }}>
        <h1>Something went wrong</h1>
        <p>Please try again. If it keeps happening, contact us and quote the reference below.</p>
        {error.digest ? <p>Reference: {error.digest}</p> : null}
        <button onClick={() => reset()}>Try again</button>
      </body>
    </html>
  );
}
