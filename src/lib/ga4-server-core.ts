import { initialCheckPriceNumber } from "./product-offer";

export type Ga4PurchaseClaim = {
  paymentId: string;
  eventId: string;
  status: string;
  amount: number;
  currency: string;
};

export type Ga4PurchaseDependencies = {
  claim: (caseId: string) => Promise<Ga4PurchaseClaim | null>;
  loadClientId: (caseId: string) => Promise<string | null>;
  send: (input: {
    clientId: string;
    eventId: string;
    transactionId: string;
    value: number;
    currency: string;
  }) => Promise<"sent" | "disabled" | "failed">;
  complete: (claim: Ga4PurchaseClaim) => Promise<void>;
  release: (claim: Ga4PurchaseClaim) => Promise<void>;
};

export type Ga4PurchaseResult =
  | "sent"
  | "not_claimed"
  | "not_verified"
  | "disabled"
  | "failed";

export type Ga4PurchaseEventInput = {
  clientId: string;
  eventId: string;
  transactionId: string;
  value: number;
  currency: string;
};

export function buildGa4PurchasePayload(input: Ga4PurchaseEventInput) {
  const params = {
    transaction_id: input.transactionId,
    event_id: input.eventId,
    value: input.value,
    currency: input.currency,
    engagement_time_msec: 1,
  };

  return {
    client_id: input.clientId,
    events: [
      { name: "payment_completed", params: { ...params } },
      { name: "purchase", params: { ...params } },
    ],
  };
}

export function isVerifiedGa4Purchase(claim: Ga4PurchaseClaim) {
  return claim.status === "verified" && claim.amount === initialCheckPriceNumber() && claim.currency === "ILS";
}

export async function processVerifiedGa4Purchase(
  caseId: string,
  dependencies: Ga4PurchaseDependencies,
): Promise<Ga4PurchaseResult> {
  const claim = await dependencies.claim(caseId);
  if (!claim) return "not_claimed";

  if (!isVerifiedGa4Purchase(claim)) {
    await dependencies.release(claim);
    return "not_verified";
  }

  const clientId = (await dependencies.loadClientId(caseId)) || stableGa4ClientId(caseId);
  let delivery: "sent" | "disabled" | "failed";
  try {
    delivery = await dependencies.send({
      clientId,
      eventId: claim.eventId,
      transactionId: claim.paymentId,
      value: claim.amount,
      currency: claim.currency,
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

export function stableGa4ClientId(identity: string) {
  let first = 2166136261;
  let second = 16777619;
  for (let index = 0; index < identity.length; index += 1) {
    const code = identity.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619) >>> 0;
    second = Math.imul(second ^ (code + index), 2246822519) >>> 0;
  }
  return `${Math.max(first, 1)}.${Math.max(second, 1)}`;
}
