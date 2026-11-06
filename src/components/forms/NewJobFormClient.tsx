"use client";

import dynamic from "next/dynamic";

/** The new-job form restores unsaved entries from browser storage, so it renders on the client only. */
export const NewJobFormClient = dynamic(() => import("./JobForms").then((m) => m.NewJobForm), {
  ssr: false,
  loading: () => <p><span className="spinner" role="status" aria-label="Loading" /> Loading form…</p>,
});
