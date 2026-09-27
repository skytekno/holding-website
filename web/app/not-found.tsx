import Link from "next/link";
export default function NotFound() {
  return (
    <section className="message-page">
      <p className="eyebrow">404 / Page unavailable</p>
      <h1>There’s nothing here yet.</h1>
      <p>This page may have moved or has not been published.</p>
      <Link className="text-link" href="/">
        Return to Sky Holding <span aria-hidden="true">↗</span>
      </Link>
    </section>
  );
}
