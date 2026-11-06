import { ForgotPasswordForm } from "@/components/forms/AuthForms";

export const metadata = { title: "Reset your password" };

export default function Forgot() {
  return (
    <div className="card" style={{ maxWidth: 480, margin: "0 auto" }}>
      <h1>Reset your password</h1>
      <ForgotPasswordForm />
    </div>
  );
}
