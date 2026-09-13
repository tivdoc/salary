// Public presentation adapter; prices and contact still come from the canonical offer.
import { productOffer as canonicalOffer, formatPrice as canonicalPrice, formatFullPrices } from '../lib/product-offer';
const offer = canonicalOffer();
export const productOffer = {
 currency: offer.currency,
 initial: {price: Number(offer.initial_check.price.amount), months: 1, maxTopics: 3},
 full: {tiers: offer.full_report.pricing.tiers, available: false, humanReviewRequired: false},
 supportEmail: offer.contact.support_email,
} as const;
export function formatPrice(amount: number) {return canonicalPrice({amount: amount.toFixed(2),currency: offer.currency});}
export const initialPrice = canonicalPrice(offer.initial_check.price);
export const fullPrice = formatFullPrices();
