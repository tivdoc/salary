import {
  isVerifiedMetaPurchase,
  type MetaCapiEventInput,
  type MetaCustomerData,
} from "./meta-events";

export type MetaPurchaseClaim = {
  paymentId: string;
  eventId: string;
  status: string;
  amount: number;
  currency: string;
};

export type MetaPurchaseDependencies = {
  claim: (caseId: string) => Promise<MetaPurchaseClaim | null>;
  loadCustomer: (caseId: string) => Promise<MetaCustomerData>;
  send: (event: MetaCapiEventInput) => Promise<"sent" | "disabled" | "failed">;
  complete: (claim: MetaPurchaseClaim) => Promise<void>;
  release: (claim: MetaPurchaseClaim) => Promise<void>;
};

export type MetaPurchaseProcessingResult =
  | "sent"
  | "not_claimed"
  | "not_verified"
  | "disabled"
  | "failed";

export async function processVerifiedMetaPurchase(
  caseId: string,
  eventSourceUrl: string,
  requestCustomerData: MetaCustomerData,
  dependencies: MetaPurchaseDependencies,
): Promise<MetaPurchaseProcessingResult> {
  const claim = await dependencies.claim(caseId);
  if (!claim) return "not_claimed";

  if (!isVerifiedMetaPurchase(claim)) {
    await dependencies.release(claim);
    return "not_verified";
  }

  let delivery: "sent" | "disabled" | "failed";
  try {
    const customer = await dependencies.loadCustomer(caseId);
    delivery = await dependencies.send({
      eventName: "Purchase",
      eventId: claim.eventId,
      eventSourceUrl,
      customer: { ...customer, ...requestCustomerData },
      customData: { value: 9.99, currency: "ILS" },
    });
  } catch (error) {
    await dependencies.release(claim);
    throw error;
  }

  if (delivery === "sent") {
    await dependencies.complete(claim);
    return "sent";
  }

  await dependencies.release(claim);
  return delivery;
}
