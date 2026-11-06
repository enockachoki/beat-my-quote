import Link from "next/link";

export default function Home() {
  return (
    <>
      <section className="hero">
        <div>
          <p className="badge">Now testing in [test area]</p>
          <h1>Got a quote? <mark>Let&apos;s beat it.</mark></h1>
          <p>Upload the quote you already have, with a few photos and a short video of the job. Vetted local builders offer to do the same work for less. Free, with no obligation.</p>
          <div className="row">
            <Link className="btn btn-primary" href="/sign-up">Upload my quote</Link>
            <a className="btn btn-secondary" href="#how-it-works">See how it works</a>
          </div>
          <ul className="ticks">
            <li>No quote visits</li>
            <li>Fixed price, in writing</li>
            <li>Deposit held securely until work starts</li>
          </ul>
        </div>
        <div className="card quote-card" aria-label="Example quote">
          <div className="row between"><strong>EXAMPLE QUOTE</strong><span className="blur" aria-hidden="true">ABC Bathrooms Ltd</span></div>
          <div className="line"><span>Strip out existing bathroom</span><span>£780.00</span></div>
          <div className="line"><span>Supply &amp; fit suite, shower over bath</span><span>£3,950.00</span></div>
          <div className="line"><span>Tiling, walls and floor (14 m²)</span><span>£1,620.00</span></div>
          <div className="line"><span>Plumbing &amp; first/second fix electrics</span><span>£850.00</span></div>
          <div className="line"><span>VAT at 20%</span><span>£1,440.00</span></div>
          <div className="line"><strong>Total inc. VAT</strong><strong className="strike">£8,640.00</strong></div>
          <p style={{ marginTop: "1rem" }}>Beat price <span className="price">£7,950</span></p>
          <p className="small">You save £690 (8%). The rival builder&apos;s name and reference are hidden before anyone sees your quote.</p>
        </div>
      </section>

      <section id="how-it-works" className="stack">
        <h2>Your quote does the work. Builders compete to beat it.</h2>
        <p>Builders on Beat My Quote never write quotes from scratch, so there&apos;s no stream of visits to your home.</p>
        <ol className="steps">
          <li><h3>Upload</h3><p>Your quote, photos, a short video, your postcode and the type of job.</p></li>
          <li><h3>We check it</h3><p>We hide the other builder&apos;s details, write a clear standard scope and set a beat price below your quote.</p></li>
          <li><h3>Builders take it</h3><p>Our own crews look first, then vetted local partners, at the beat price.</p></li>
          <li><h3>You accept</h3><p>Accept the offer and pay a deposit, held securely until work starts.</p></li>
          <li><h3>Pre-start check</h3><p>A short visit to confirm the job matches your uploads. Then the work begins at the agreed price.</p></li>
        </ol>
      </section>

      <section className="card" style={{ marginTop: "2rem" }}>
        <h2>The pre-start check. One short check, not another quote.</h2>
        <p>The price you accepted is fixed. Builders can&apos;t add costs for things that were reasonably visible in your uploads or scope.</p>
        <p>If the builder finds something that wasn&apos;t reasonably visible, they must put it on a written Variation Form with a price before doing that work. You decide. If you say no, the contract ends and your deposit is refunded in full.</p>
      </section>
    </>
  );
}
