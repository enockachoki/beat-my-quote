"use client";

import { useEffect } from "react";
import Link from "next/link";
import { reportClientError } from "@/components/api";

/** Route-level error boundary: one failing section never takes down the whole site. */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    reportClientError(error.message, { digest: error.digest });
  }, [error]);
  return (
    <div className="card" role="alert">
      <h1>Something went wrong</h1>
      <p>We couldn&apos;t load this page. Anything you&apos;d already saved is safe.</p>
      {error.digest ? <p className="small">Reference: {error.digest}</p> : null}
      <div className="row">
        <button className="btn btn-primary" onClick={() => reset()}>Try again</button>
        <Link className="btn btn-secondary" href="/">Go to the home page</Link>
      </div>
    </div>
  );
}
