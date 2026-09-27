"use client";
import { useRef, useState, type FormEvent } from "react";
import Script from "next/script";
import type { RuntimeConfig } from "@/lib/types";

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (options: {
            client_id: string;
            callback: (response: { credential: string }) => void;
          }) => void;
          renderButton: (
            element: HTMLElement,
            options: {
              theme: string;
              size: string;
              width: number;
              text: string;
            },
          ) => void;
          disableAutoSelect: () => void;
        };
      };
    };
  }
}
export function SignIn({
  config,
  onToken,
  pending,
  error,
}: {
  config: RuntimeConfig;
  onToken: (token: string) => void;
  pending: boolean;
  error: string;
}) {
  const buttonRef = useRef<HTMLDivElement>(null);
  const [developmentToken, setDevelopmentToken] = useState("");
  const [scriptError, setScriptError] = useState(false);
  function initializeGoogle() {
    if (!window.google || !buttonRef.current) return;
    window.google.accounts.id.initialize({
      client_id: config.googleClientId,
      callback: (response) => onToken(response.credential),
    });
    window.google.accounts.id.renderButton(buttonRef.current, {
      theme: "outline",
      size: "large",
      width: 280,
      text: "signin_with",
    });
  }
  function developmentSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onToken(developmentToken.trim());
    setDevelopmentToken("");
  }
  return (
    <main className="sign-in-screen">
      <section className="sign-in-brand">
        <a href={config.siteUrl} className="brand-lockup">
          <span className="brand-symbol" aria-hidden="true">
            S
          </span>
          SKY HOLDING
        </a>
        <div>
          <p className="eyebrow">Your voice. One place.</p>
          <h1>
            A home for
            <br />
            your stories.
          </h1>
          <p>Manage the official Sky Holding website.</p>
        </div>
        <span className="brand-caption">CONTENT STUDIO</span>
      </section>
      <section className="sign-in-panel">
        <div className="sign-in-card">
          <p className="eyebrow">Content studio</p>
          <h2>Welcome back.</h2>
          <p>
            Sign in with your authorized Google account to manage pages and
            media.
          </p>
          {(error || scriptError) && (
            <p className="notice error" role="alert">
              {error ||
                "Google sign-in could not load. Check your connection and reload the page."}
            </p>
          )}
          {config.googleClientId ? (
            <>
              <Script
                src="https://accounts.google.com/gsi/client"
                strategy="afterInteractive"
                onReady={initializeGoogle}
                onError={() => setScriptError(true)}
              />
              <div
                className="google-sign-in"
                ref={buttonRef}
                aria-label="Sign in with Google"
              />
            </>
          ) : (
            !config.development && (
              <p className="notice" role="status">
                Google sign-in has not been configured. Contact your
                administrator.
              </p>
            )
          )}
          {pending && <p role="status">Checking access…</p>}
          {config.development && (
            <form className="development-login" onSubmit={developmentSignIn}>
              <p className="eyebrow">Local development</p>
              <label htmlFor="development-token">Development API token</label>
              <input
                id="development-token"
                type="password"
                value={developmentToken}
                onChange={(event) => setDevelopmentToken(event.target.value)}
                autoComplete="off"
                required
              />
              <button
                className="button primary"
                disabled={pending}
                type="submit"
              >
                Open studio <span aria-hidden="true">↗</span>
              </button>
            </form>
          )}
          <p className="login-note">Access is limited to approved editors.</p>
        </div>
      </section>
    </main>
  );
}
