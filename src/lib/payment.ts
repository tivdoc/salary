export const INITIAL_CHECK_PRICE = 9.99;
export const INITIAL_CHECK_CURRENCY = "ILS";

export interface PaymentHandoff {
  provider: "invoice4u";
  url: string;
}

export interface PaymentAdapter {
  createHandoff(): PaymentHandoff;
}

export class Invoice4uHostedPaymentAdapter implements PaymentAdapter {
  constructor(private readonly hostedPaymentUrl = process.env.INVOICE4U_PAYMENT_URL) {}

  createHandoff(): PaymentHandoff {
    if (!this.hostedPaymentUrl) {
      throw new Error("INVOICE4U_PAYMENT_URL is not configured");
    }

    const url = new URL(this.hostedPaymentUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error("INVOICE4U_PAYMENT_URL must be an HTTP(S) URL");
    }

    return { provider: "invoice4u", url: url.toString() };
  }
}
