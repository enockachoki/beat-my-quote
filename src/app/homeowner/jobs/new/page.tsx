import { requirePageUser } from "@/server/http/pageAuth";
import { NewJobFormClient } from "@/components/forms/NewJobFormClient";

export const metadata = { title: "Upload your quote" };

export default async function NewJob() {
  await requirePageUser(["homeowner"], "/homeowner/jobs/new");
  return (
    <>
      <h1>Upload your quote</h1>
      <p>Three steps. About five minutes on your phone. Have your quote ready as a PDF or a photo; we&apos;ll ask for photos and a short video next.</p>
      <NewJobFormClient />
    </>
  );
}
