import { requirePageUser } from "@/server/http/pageAuth";
import { PaymentStatus } from "@/components/forms/Actions";

export const metadata = { title: "Confirming payment" };

export default async function PaymentReturn({ params }: { params: Promise<{ jobId: string; paymentId: string }> }) {
  const { jobId, paymentId } = await params;
  await requirePageUser(["homeowner"], `/homeowner/jobs/${jobId}`);
  return (
    <>
      <h1>Confirming your payment</h1>
      <PaymentStatus paymentId={paymentId} jobId={jobId} />
    </>
  );
}
