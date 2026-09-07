// Public offer shared by UI and server payment code. Full report has no checkout yet.
export const productOffer = {
  currency: "ILS",
  initial: { available: false, price: 9.99, months: 1, maxTopics: 3 },
  full: { price: 149, available: false, humanReviewRequired: true },
  supportEmail: "info@tivdoc.com",
} as const;

export function formatPrice(amount: number) {
  return `${new Intl.NumberFormat("he-IL", { maximumFractionDigits: 2 }).format(amount)} ₪`;
}
export const initialPrice = formatPrice(productOffer.initial.price);
export const fullPrice = formatPrice(productOffer.full.price);
