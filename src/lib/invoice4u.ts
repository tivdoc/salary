import "server-only";
import type { Invoice4uClearingLog } from "./payment-verification";

const INVOICE4U_API_BASES = {
  production: "https://api.invoice4u.co.il/Services/ApiService.svc",
  qa: "https://apiqa.invoice4u.co.il/Services/ApiService.svc",
} as const;

type Fetcher = typeof fetch;

export class Invoice4uApiError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "Invoice4uApiError";
  }
}

type CheckoutInput = {
  caseId: string;
  orderId: string;
  fullName: string;
  phone: string;
  email: string;
  returnUrl: string;
  amount: number;
  currency: string;
  kind?: "initial" | "full";
};

export type Invoice4uCheckout = {
  url: string;
  clearingLogId: string;
  paymentId: string | null;
};

function unwrapWcfPayload(value: unknown): unknown {
  let current = value;
  for (let index = 0; index < 3; index += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) break;
    const record = current as Record<string, unknown>;
    if ("d" in record) {
      current = record.d;
    } else {
      const resultKey = Object.keys(record).find((key) => key.endsWith("Result"));
      if (!resultKey) break;
      current = record[resultKey];
    }
    if (typeof current === "string") {
      try {
        current = JSON.parse(current);
      } catch {
        throw new Invoice4uApiError("invalid_provider_response");
      }
    }
  }
  return current;
}

function referenceValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" && (typeof value !== "number" || !Number.isSafeInteger(value))) {
    throw new Invoice4uApiError("invalid_provider_response");
  }
  return String(value).trim() || null;
}

function consistentReference(values: unknown[]): string | null {
  const references = values.map(referenceValue).filter((value) => value !== null);
  if (new Set(references).size > 1) throw new Invoice4uApiError("invalid_provider_response");
  return references[0] ?? null;
}

function openInfoValue(payload: Record<string, unknown>, key: string) {
  const info = payload.OpenInfo;
  if (Array.isArray(info)) {
    return consistentReference(info.filter((item) => item && typeof item === "object" && item.Key === key)
      .map((item) => item.Value));
  }
  if (info && typeof info === "object") return referenceValue((info as Record<string, unknown>)[key]);
  return null;
}

function providerRejectionCode(payload: Record<string, unknown>) {
  if (!Array.isArray(payload.Errors) || payload.Errors.length === 0) return null;
  const firstError = payload.Errors[0];
  const id =
    firstError && typeof firstError === "object"
      ? (firstError as Record<string, unknown>).ID
      : null;
  return typeof id === "number" ? `provider_rejected_${id}` : "provider_rejected";
}

export function invoice4uErrorCode(error: unknown) {
  if (error instanceof Invoice4uApiError) return error.code;
  if (
    error &&
    typeof error === "object" &&
    (error as Record<string, unknown>).name === "Invoice4uApiError" &&
    typeof (error as Record<string, unknown>).code === "string"
  ) {
    return (error as Record<string, unknown>).code as string;
  }
  return null;
}

export class Invoice4uClient {
  private readonly apiKey: string;
  private readonly clearingCompanyType: number;
  private readonly apiBase: string;
  private readonly isQaMode: boolean;

  constructor(
    apiKey = process.env.INVOICE4U_API_KEY,
    private readonly fetcher: Fetcher = fetch,
    clearingCompanyType = Number(process.env.INVOICE4U_CLEARING_COMPANY_TYPE),
    environment = process.env.INVOICE4U_ENVIRONMENT ?? 'production',
  ) {
    if (!apiKey) throw new Invoice4uApiError("missing_api_key");
    if (![6, 7, 12, 15].includes(clearingCompanyType)) {
      throw new Invoice4uApiError("invalid_clearing_company_type");
    }
    if (environment !== 'qa' && environment !== 'production') {
      throw new Invoice4uApiError('invalid_provider_environment');
    }
    this.apiBase = INVOICE4U_API_BASES[environment];
    this.isQaMode = environment === 'qa';
    this.apiKey = apiKey;
    this.clearingCompanyType = clearingCompanyType;
  }

  private async post(path: string, body: Record<string, unknown>) {
    let response: Response;
    try {
      response = await this.fetcher(`${this.apiBase}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Invoice4uApiError("provider_unavailable");
    }
    if (!response.ok) throw new Invoice4uApiError("provider_http_error");

    try {
      return unwrapWcfPayload(await response.json());
    } catch (error) {
      if (error instanceof Invoice4uApiError) throw error;
      throw new Invoice4uApiError("invalid_provider_response");
    }
  }

  async createCheckout(input: CheckoutInput): Promise<Invoice4uCheckout> {
    const minor = Math.round(input.amount * 100);
    if (!Number.isSafeInteger(minor) || minor <= 0 || minor / 100 !== input.amount) {
      throw new Invoice4uApiError("invalid_checkout_amount");
    }
    if (input.currency !== "ILS") throw new Invoice4uApiError("invalid_checkout_currency");
    const response = await this.post("ProcessApiRequestV2", {
      request: {
        Invoice4UUserApiKey: this.apiKey,
        Type: 1,
        CreditCardCompanyType: this.clearingCompanyType,
        FullName: input.fullName,
        Phone: input.phone,
        Email: input.email,
        Sum: input.amount,
        Description: `Tivdoc salary ${input.kind=== "full"?"full report":"initial check"} (${input.caseId})`,
        PaymentsNum: 1,
        Currency: "NIS",
        IsQaMode: this.isQaMode,
        OrderIdClientUsage: input.orderId,
        IsDocCreate: true,
        DocHeadline: input.kind==="full"?"Tivdoc - דוח מלא":"Tivdoc - בדיקה ראשונית",
        DocComments: `Case ${input.caseId}`,
        IsManualDocCreationsWithParams: false,
        IsGeneralClient: true,
        IsAutoCreateCustomer: true,
        ReturnUrl: input.returnUrl,
        AddToken: false,
        AddTokenAndCharge: false,
        ChargeWithToken: false,
        Refund: false,
        IsStandingOrderClearance: false,
        StandingOrderDuration: 0,
        DocLanguage: "he",
      },
    });
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new Invoice4uApiError("invalid_provider_response");
    }
    const payload = response as Record<string, unknown>;
    const rejectionCode = providerRejectionCode(payload);
    if (rejectionCode) throw new Invoice4uApiError(rejectionCode);

    const rawPaymentId = consistentReference([openInfoValue(payload, "PaymentId"), payload.PaymentId]);
    const clearingLogId = openInfoValue(payload, "I4UClearingLogId");
    const paymentId = rawPaymentId && rawPaymentId !== "0" ? rawPaymentId : null;
    const url = typeof payload.ClearingRedirectUrl === "string" ? payload.ClearingRedirectUrl : "";
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Invoice4uApiError("missing_checkout_url");
    }
    if (parsedUrl.protocol !== "https:" || !clearingLogId) {
      throw new Invoice4uApiError("invalid_checkout_session");
    }

    return { url: parsedUrl.toString(), clearingLogId, paymentId };
  }

  async getClearingLogById(clearingLogId: string): Promise<Invoice4uClearingLog | null> {
    const response = await this.post("GetClearingLogById", {
      clearingLogId,
      token: this.apiKey,
    });
    if (!response) return null;

    const candidates = Array.isArray(response) ? response : [response];
    const match = candidates.find(
      (candidate) =>
        candidate &&
        typeof candidate === "object" &&
        String((candidate as Record<string, unknown>).Id ?? "") === clearingLogId,
    );
    if (!match || typeof match !== "object" || Array.isArray(match)) return null;
    return match as Invoice4uClearingLog;
  }
}
