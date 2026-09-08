"use client";
import { productOffer } from "@/config/product-offer";
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
  const [currentSection, setCurrentSection] = useState("");
  const navigation = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const header = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    navigation.current?.querySelector<HTMLAnchorElement>("a")?.focus();
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        toggle.current?.focus();
      }
    }
    function outside(event: PointerEvent) {
      if (!header.current?.contains(event.target as Node)) setOpen(false);
    }
    function focusOutside(event: FocusEvent) {
      if (!header.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("focusin", focusOutside);
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("focusin", focusOutside);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open]);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const entering = entries.find((entry) => entry.isIntersecting);
        if (entering) setCurrentSection(entering.target.id);
      },
      { rootMargin: "-15% 0px -65% 0px", threshold: 0 },
    );
    ["hero-title", ...links.map(([id]) => id)].forEach((id) => {
      const section = document.getElementById(id);
      if (section) observer.observe(section);
    });
    return () => observer.disconnect();
  }, []);
  function followSection(id: string) {
    setOpen(false);
    setCurrentSection(id);
    const section = document.getElementById(id);
    if (section) {
      const heading = section.querySelector<HTMLElement>("h2") ?? section;
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }
  return (
    <header className="public-header" ref={header}>
      <div className="shell public-header__inner">
        <Link href="/" aria-label="תבדוק, עמוד הבית">
          <BrandLogo />
        </Link>
        <nav
          className={open ? "public-nav is-open" : "public-nav"}
          ref={navigation}
          id="public-navigation"
          aria-label="ניווט ראשי"
        >
          {links.map(([id, label]) => (
            <Link
              key={id}
              href={"/#" + id}
              aria-current={currentSection === id ? "location" : undefined}
              onClick={() => followSection(id)}
            >
              {label}
            </Link>
          ))}
        </nav>
        <div className="public-header__actions">
          <Link
            className="return-link"
            href="/check/received"
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
              {productOffer.initial.available ? "התחלת בדיקה" : "זמינות השירות"}{" "}
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
