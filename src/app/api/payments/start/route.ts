import { NextResponse } from "next/server";
import { readCaseIdFromCookie } from "@/lib/case-cookie";
import {
  INITIAL_CHECK_CURRENCY,
  INITIAL_CHECK_PRICE,
  PAYMENT_RETURN_TOKEN_TTL_MS,
  createPaymentReturnToken,
  getPaymentReturnUrl,
  hashPaymentReturnToken,
  invoice4uOrderIdForCase,
  isInvoice4uCheckoutReusable,
} from "@/lib/payment";
import { Invoice4uClient, invoice4uErrorCode } from "@/lib/invoice4u";
import { metaRequestContext, sendMetaCapiEvent } from "@/lib/meta-capi";
import { metaEventId, type MetaEventDescriptor } from "@/lib/meta-events";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { recordCaseFunnelEvent } from "@/lib/funnel-server";

export const runtime = "nodejs";

function safeInternalErrorCode(error: unknown, stage: string) {
  const code =
    error && typeof error === "object" ? (error as Record<string, unknown>).code : null;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(code)
    ? `internal_${stage}_${code}`
    : `internal_${stage}`;
}

type SalaryCaseForMeta = {
  first_name: string;
  email: string;
  phone: string;
};

async function deliverCheckoutMeta(
  request: Request,
  payment: { id: string; eventId: string; sentAt: string | null },
  salaryCase: SalaryCaseForMeta,
) {
  const descriptor: MetaEventDescriptor = {
    eventName: "InitiateCheckout",
    eventId: payment.eventId,
    customData: { value: INITIAL_CHECK_PRICE, currency: INITIAL_CHECK_CURRENCY },
  };
  if (payment.sentAt) return descriptor;

  const context = metaRequestContext(request, "/check/payment");
  const delivery = await sendMetaCapiEvent({
    ...descriptor,
    eventSourceUrl: context.eventSourceUrl,
    customer: {
      firstName: salaryCase.first_name,
      email: salaryCase.email,
      phone: salaryCase.phone,
      clientIpAddress: context.clientIpAddress,
      clientUserAgent: context.clientUserAgent,
      fbp: context.fbp,
      fbc: context.fbc,
    },
  });
  if (delivery.status === "sent") {
    const result = await getSupabaseAdmin()
      .from("payments")
      .update({ meta_checkout_sent_at: new Date().toISOString() })
      .eq("id", payment.id)
      .is("meta_checkout_sent_at", null);
    if (result.error) console.warn("Meta checkout delivery marker failed", result.error.code);
  } else if (delivery.status === "failed") {
    console.warn("Meta checkout delivery deferred", delivery.code);
  }
  return descriptor;
}

export async function POST(request: Request) {
  const caseId = await readCaseIdFromCookie();
  if (!caseId) {
    return NextResponse.json({ error: "תיק הבדיקה לא נמצא. יש להתחיל מחדש." }, { status: 401 });
  }

  let failureStage = "load_case";
  try {
    const supabase = getSupabaseAdmin();
    const [caseResult, documentResult] = await Promise.all([
      supabase
        .from("cases")
        .select("id,public_id,first_name,email,phone,status,payment_status")
        .eq("id", caseId)
        .single(),
      supabase
        .from("documents")
        .select("id", { count: "exact", head: true })
        .eq("case_id", caseId)
        .eq("document_type", "payslip"),
    ]);
    const { data: salaryCase, error: caseError } = caseResult;
    if (caseError || !salaryCase) {
      return NextResponse.json({ error: "תיק הבדיקה לא נמצא" }, { status: 404 });
    }

    if (["paid", "verified"].includes(salaryCase.payment_status)) {
      return NextResponse.json({ url: "/check/received", publicId: salaryCase.public_id });
    }

    const { count, error: documentError } = documentResult;
    if (documentError) throw documentError;
    if (!count) {
      return NextResponse.json({ error: "צריך להעלות תלוש לפני המעבר לתשלום" }, { status: 409 });
    }

    const idempotencyKey = `${caseId}:initial-check`;
    const orderId = invoice4uOrderIdForCase(salaryCase.public_id);
    const { data: existingPayment, error: existingPaymentError } = await supabase
      .from("payments")
      .select("id,status,provider_redirect_url,provider_checkout_created_at,meta_checkout_event_id,meta_checkout_sent_at")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (existingPaymentError) throw existingPaymentError;
    if (existingPayment?.status === "verified") {
      return NextResponse.json({ url: "/check/received", publicId: salaryCase.public_id });
    }
    if (
      existingPayment?.status === "pending" &&
      isInvoice4uCheckoutReusable(
        existingPayment.provider_redirect_url,
        existingPayment.provider_checkout_created_at,
      )
    ) {
      const eventId =
        existingPayment.meta_checkout_event_id ??
        metaEventId("InitiateCheckout", existingPayment.id);
      if (!existingPayment.meta_checkout_event_id) {
        const eventUpdate = await supabase
          .from("payments")
          .update({ meta_checkout_event_id: eventId })
          .eq("id", existingPayment.id)
          .is("meta_checkout_event_id", null);
        if (eventUpdate.error) throw eventUpdate.error;
      }
      const metaEvent = await deliverCheckoutMeta(
        request,
        {
          id: existingPayment.id,
          eventId,
          sentAt: existingPayment.meta_checkout_sent_at,
        },
        salaryCase,
      );
      await recordCaseFunnelEvent(caseId, "checkout_started");
      return NextResponse.json({
        url: existingPayment.provider_redirect_url,
        publicId: salaryCase.public_id,
        metaEvent,
      });
    }

    const paymentReturnToken = createPaymentReturnToken();
    const paymentReturnTokenExpiresAt = new Date(
      Date.now() + PAYMENT_RETURN_TOKEN_TTL_MS,
    ).toISOString();

    const pendingPaymentValues = {
      case_id: caseId,
      provider: "invoice4u",
      amount: INITIAL_CHECK_PRICE,
      currency: INITIAL_CHECK_CURRENCY,
      status: "pending",
      provider_payment_id: null,
      provider_order_id: orderId,
      provider_redirect_url: null,
      provider_checkout_created_at: null,
      payment_return_token_hash: hashPaymentReturnToken(paymentReturnToken),
      payment_return_token_expires_at: paymentReturnTokenExpiresAt,
      payment_return_token_consumed_at: null,
      provider_reference: null,
      provider_clearing_log_id: null,
      provider_confirmation_number: null,
      verified_at: null,
      analytics_reported_at: null,
      idempotency_key: idempotencyKey,
    };
    failureStage = "persist_pending_payment";
    const pendingPayment = existingPayment
      ? await supabase
          .from("payments")
          .update(pendingPaymentValues)
          .eq("id", existingPayment.id)
          .neq("status", "verified")
          .select("id,status")
          .maybeSingle()
      : await supabase
          .from("payments")
          .insert(pendingPaymentValues)
          .select("id,status")
          .single();
    if (pendingPayment.error) throw pendingPayment.error;
    if (!pendingPayment.data || pendingPayment.data.status === "verified") {
      return NextResponse.json({ url: "/check/received", publicId: salaryCase.public_id });
    }

    failureStage = "mark_case_pending";
    const { error: updateError } = await supabase
      .from("cases")
      .update({
        status: "payment_pending",
        payment_status: "pending",
        updated_at: new Date().toISOString(),
      })
      .eq("id", caseId)
      .not("payment_status", "in", "(paid,verified)");
    if (updateError) throw updateError;

    failureStage = "request_provider_checkout";
    const checkout = await new Invoice4uClient().createCheckout({
      caseId: salaryCase.public_id,
      orderId,
      fullName: salaryCase.first_name,
      phone: salaryCase.phone,
      email: salaryCase.email,
      returnUrl: getPaymentReturnUrl(paymentReturnToken),
      amount: INITIAL_CHECK_PRICE,
      currency: INITIAL_CHECK_CURRENCY,
    });
    failureStage = "persist_provider_checkout";
    const checkoutEventId = metaEventId("InitiateCheckout", pendingPayment.data.id);
    const persistedPayment = await supabase
      .from("payments")
      .update({
        provider_payment_id: checkout.paymentId,
        provider_clearing_log_id: checkout.clearingLogId,
        provider_redirect_url: checkout.url,
        provider_checkout_created_at: new Date().toISOString(),
        meta_checkout_event_id: checkoutEventId,
      })
      .eq("id", pendingPayment.data.id)
      .neq("status", "verified")
      .select("status,provider_redirect_url,meta_checkout_sent_at")
      .maybeSingle();
    if (persistedPayment.error) throw persistedPayment.error;
    if (!persistedPayment.data || persistedPayment.data.status === "verified") {
      return NextResponse.json({ url: "/check/received", publicId: salaryCase.public_id });
    }
    if (!persistedPayment.data.provider_redirect_url) {
      throw new Error("Invoice4u checkout URL was not persisted");
    }

    const metaEvent = await deliverCheckoutMeta(
      request,
      {
        id: pendingPayment.data.id,
        eventId: checkoutEventId,
        sentAt: persistedPayment.data.meta_checkout_sent_at,
      },
      salaryCase,
    );
    await recordCaseFunnelEvent(caseId, "checkout_started");

    return NextResponse.json({
      url: persistedPayment.data.provider_redirect_url,
      publicId: salaryCase.public_id,
      metaEvent,
    });
  } catch (error) {
    console.error(
      "Payment handoff failed",
      invoice4uErrorCode(error) ?? safeInternalErrorCode(error, failureStage),
    );
    return NextResponse.json(
      { error: "לא הצלחנו לפתוח את עמוד התשלום כרגע. אפשר לנסות שוב." },
      { status: 503 },
    );
  }
}
