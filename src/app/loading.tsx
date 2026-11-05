export default function Loading() {
  return (
    <div className="row" aria-live="polite">
      <span className="spinner" role="status" aria-label="Loading" /> <span>Loading…</span>
    </div>
  );
}
