import { TrackedLink } from "@/components/tracked-link";
import { formatPrice, productOffer } from "@/lib/product-offer";

/**
 * Site S5: the canvas's mobile sticky call to action. Rendered on every screen
 * width and hidden above the mobile breakpoint in CSS, so there is no
 * client-side width check and nothing shifts after hydration.
 */
export function StickyCta() {
  const price = formatPrice(productOffer().initial_check.price);
  return (
    <div className="v5-sticky" role="complementary" aria-label="התחלת בדיקה">
      <TrackedLink className="button button--primary v5-cta v5-sticky__button" href="/check" eventName="start_check">
        לבדיקת התלוש שלי · {price}
      </TrackedLink>
    </div>
  );
}
