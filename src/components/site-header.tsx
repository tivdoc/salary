"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { List } from "@phosphor-icons/react/dist/csr/List";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { ArrowLeft } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { BrandLogo } from "@/components/brand-logo";
import { TrackedLink } from "@/components/tracked-link";
const links = [
  ["how-it-works", "איך זה עובד"],
  ["what-you-get", "מה מקבלים"],
  ["pricing", "מחירים"],
  ["about", "מי אנחנו"],
];
export function SiteHeader({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const header = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        toggle.current?.focus();
      }
    }
    function outside(event: PointerEvent) {
      if (!header.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open]);
  return (
    <header className="public-header" ref={header}>
      <div className="shell public-header__inner">
        <Link href="/" aria-label="תבדוק, עמוד הבית">
          <BrandLogo />
        </Link>
        <nav
          className={open ? "public-nav is-open" : "public-nav"}
          id="public-navigation"
          aria-label="ניווט ראשי"
        >
          {links.map(([id, label]) => (
            <Link key={id} href={"/#" + id} onClick={() => setOpen(false)}>
              {label}
            </Link>
          ))}
        </nav>
        <div className="public-header__actions">
          <Link
            className="return-link"
            href="/cases"
            prefetch={compact ? false : null}
          >
            חזרה לבדיקה
          </Link>
          {!compact && (
            <TrackedLink
              className="button button--primary header-start"
              href="/check"
              eventName="start_check"
            >
              התחלת בדיקה{" "}
              <ArrowLeft aria-hidden="true" />
            </TrackedLink>
          )}
          <button
            className="menu-toggle"
            ref={toggle}
            type="button"
            aria-expanded={open}
            aria-controls="public-navigation"
            aria-label={open ? "סגירת תפריט" : "פתיחת תפריט"}
            onClick={() => setOpen(!open)}
          >
            {open ? <X size={24} /> : <List size={24} />}
          </button>
        </div>
      </div>
    </header>
  );
}
