"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <section className="message-page">
      <p className="eyebrow">Connection interrupted</p>
      <h1>We’ll be back shortly.</h1>
      <p>We couldn’t load this page. Please try again in a moment.</p>
      <button className="text-link" onClick={reset}>
        Try again <span aria-hidden="true">↗</span>
      </button>
    </section>
  );
}
