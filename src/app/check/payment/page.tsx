import { productOffer } from "@/config/product-offer";
import { ServiceUnavailable } from "@/components/check/service-unavailable";
import { PaymentHandoff } from "@/components/check/payment-handoff";

export default function PaymentPage() {
  return productOffer.initial.available ? <PaymentHandoff /> : <ServiceUnavailable />;
}
