"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef } from "react";

export type NavigationItem = { href: string; label: string };

export function SiteNavigation({ items }: { items: NavigationItem[] }) {
  const pathname = usePathname();
  const disclosure = useRef<HTMLDetailsElement>(null);
  const close = () => disclosure.current?.removeAttribute("open");
  const links = (className?: string) => items.map((item) => (
    <Link
      key={item.href}
      href={item.href}
      className={className}
      aria-current={pathname === item.href ? "page" : undefined}
      onClick={close}
    >
      {item.label}
    </Link>
  ));

  return (
    <>
      <nav className="desktop-navigation" aria-label="Main navigation">
        {items.slice(0, 4).map((item) => (
          <Link key={item.href} href={item.href} title={item.label} aria-current={pathname === item.href ? "page" : undefined}>
            {item.label}
          </Link>
        ))}
      </nav>
      <details
        ref={disclosure}
        className={`navigation-disclosure${items.length > 4 ? " has-overflow" : ""}`}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            close();
            disclosure.current?.querySelector("summary")?.focus();
          }
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) close();
        }}
      >
        <summary>
          <span>Menu</span>
          <span className="menu-icon" aria-hidden="true"><i /><i /></span>
        </summary>
        <nav className="menu-panel" aria-label="Expanded navigation">
          {links()}
        </nav>
      </details>
    </>
  );
}
