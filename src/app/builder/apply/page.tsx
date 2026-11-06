import { requirePageUser } from "@/server/http/pageAuth";
import { BuilderApplicationForm } from "@/components/forms/BuilderForms";

export const metadata = { title: "Builder application" };

export default async function Apply() {
  await requirePageUser(["builder"], "/builder/apply");
  return (
    <>
      <h1>Builder application</h1>
      <p>Partners pay a success fee only on jobs they win. There are no lead fees.</p>
      <BuilderApplicationForm />
    </>
  );
}
