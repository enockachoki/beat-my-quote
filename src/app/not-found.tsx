import Link from "next/link";

export default function NotFound() {
  return (
    <div className="card">
      <h1>Page not found</h1>
      <p>This page doesn&apos;t exist, or you don&apos;t have access to it.</p>
      <Link className="btn btn-primary" href="/">Go to the home page</Link>
    </div>
  );
}
