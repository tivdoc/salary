import { createHash } from "node:crypto";
import { initialCheckPriceNumber } from "./product-offer";

export const META_GRAPH_API_VERSION = "v26.0";

export type MetaConversionEventName = "Lead" | "InitiateCheckout" | "Purchase";

export type MetaEventDescriptor = {
  eventName: MetaConversionEventName;
  eventId: string;
  customData?: {
    value?: number;
    currency?: string;
  };
};

export type MetaCustomerData = {
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  clientIpAddress?: string | null;
  clientUserAgent?: string | null;
  fbp?: string | null;
  fbc?: string | null;
};

export type MetaCapiEventInput = MetaEventDescriptor & {
  eventSourceUrl: string;
  customer: MetaCustomerData;
  eventTime?: number;
};

export type MetaCapiConfig = {
  accessToken: string;
  datasetId: string;
  testEventCode?: string;
};

type Environment = Record<string, string | undefined>;

const EVENT_ID_PART_PATTERN = /[^A-Za-z0-9_.:-]/g;

export function metaEventId(eventName: MetaConversionEventName, identity: string) {
  const safeIdentity = identity.replace(EVENT_ID_PART_PATTERN, "-").slice(0, 80);
  return `tivdoc:${eventName}:${safeIdentity}`;
}

export function resolveMetaCapiConfig(environment: Environment): MetaCapiConfig | null {
  const accessToken = environment.META_CAPI_ACCESS_TOKEN?.trim();
  const datasetId = (
    environment.META_DATASET_ID || environment.NEXT_PUBLIC_META_PIXEL_ID
  )?.trim();
  if (!accessToken || !datasetId) return null;

  const testEventCode = environment.META_CAPI_TEST_EVENT_CODE?.trim();
  return {
    accessToken,
    datasetId,
    ...(testEventCode ? { testEventCode } : {}),
  };
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function normalizePhone(value: string) {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `972${digits.slice(1)}`;
  return digits;
}

function normalizeFirstName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}]/gu, "");
}

function hashedValue(value: string | null | undefined, normalize: (value: string) => string) {
  if (!value?.trim()) return null;
  const normalized = normalize(value);
  return normalized ? sha256(normalized) : null;
}

function validMetaCookie(value: string | null | undefined) {
  if (!value || value.length > 512 || !/^fb\.\d+\.[A-Za-z0-9._-]+$/.test(value)) return null;
  return value;
}

function validHeaderValue(value: string | null | undefined, maxLength: number) {
  const normalized = value?.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

export function buildMetaUserData(customer: MetaCustomerData) {
  const email = hashedValue(customer.email, normalizeEmail);
  const phone = hashedValue(customer.phone, normalizePhone);
  const firstName = hashedValue(customer.firstName, normalizeFirstName);
  const clientIpAddress = validHeaderValue(customer.clientIpAddress, 64);
  const clientUserAgent = validHeaderValue(customer.clientUserAgent, 1024);
  const fbp = validMetaCookie(customer.fbp);
  const fbc = validMetaCookie(customer.fbc);

  return {
    ...(email ? { em: [email] } : {}),
    ...(phone ? { ph: [phone] } : {}),
    ...(firstName ? { fn: [firstName] } : {}),
    ...(clientIpAddress ? { client_ip_address: clientIpAddress } : {}),
    ...(clientUserAgent ? { client_user_agent: clientUserAgent } : {}),
    ...(fbp ? { fbp } : {}),
    ...(fbc ? { fbc } : {}),
  };
}

export function buildMetaCapiPayload(input: MetaCapiEventInput) {
  return {
    event_name: input.eventName,
    event_time: input.eventTime ?? Math.floor(Date.now() / 1000),
    event_id: input.eventId,
    action_source: "website" as const,
    event_source_url: input.eventSourceUrl,
    user_data: buildMetaUserData(input.customer),
    ...(input.customData ? { custom_data: input.customData } : {}),
  };
}

export function isVerifiedMetaPurchase(input: {
  status: string;
  amount: number;
  currency: string;
}) {
  return input.status === "verified" && input.amount === initialCheckPriceNumber() && input.currency === "ILS";
}
