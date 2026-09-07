import { productOffer } from "@/config/product-offer";
import { ServiceUnavailable } from "@/components/check/service-unavailable";
import { Questionnaire } from "@/components/check/questionnaire";

export default function CheckPage() {
  return productOffer.initial.available ? <Questionnaire /> : <ServiceUnavailable />;
}
