export const metadata = { title: "Privacy (draft)" };

export default function Privacy() {
  return (
    <article className="card">
      <p className="badge">DRAFT WORDING FOR SOLICITOR REVIEW</p>
      <h1>Privacy Notice</h1>
      <p>This is a placeholder for the UK GDPR privacy notice in the legal pack.</p>
      <ul>
        <li>Your original quote is only seen by our reviewers. Builders see a redacted copy and a standard scope.</li>
        <li>Your name, contact details and full address are hidden from builders until you accept an offer.</li>
        <li>Location data (GPS) is removed from your photos before any builder can see them.</li>
        <li>Files are stored privately and shared only through links that expire after a few minutes.</li>
      </ul>
    </article>
  );
}
