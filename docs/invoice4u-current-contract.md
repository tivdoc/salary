# Invoice4U contract verification — 2026-09-08

The supplier's [official commerce page](https://www.invoice4u.co.il/features/e-commerce/) links to its [current API documentation](https://invoice4u.gitbook.io/invoice4u-docs). This resolves the earlier lack of a documented refund request shape. It does **not** establish that this merchant has a working QA account, that transport has been exercised, or that a refund has settled.

## Observed contract and implementation changes

The [clearing log reference](https://invoice4u.gitbook.io/invoice4u-docs/clearing-payments/clearing-logs) distinguishes request and response rows, token creation, monetary charges, refunds and previously credited charges. Native currency is numeric (1 represents NIS). The old validator used only a legacy currency name and success/amount/reference fields. Eight isolated tests reproduced acceptance of non-charge or credited evidence, rejection of the documented native currency, and acceptance of contradictory currencies.

The validator now rejects present non-charge, malformed or contradictory markers; already credited charges require reconciliation. Both native and legacy currency representations must agree. Historical envelopes without the newer marker fields retain their prior read behavior; this is not a claim that absent markers independently prove a modern provider contract. The exact stored clearing-log ID and the existing payment/reference checks remain mandatory. A quoted initial price of zero cannot be verified as a paid purchase.

The [getting-started reference](https://invoice4u.gitbook.io/invoice4u-docs/getting-started/welcome) documents separate production and QA endpoints. `Invoice4uClient` now accepts the server setting `INVOICE4U_ENVIRONMENT=qa` or `production`; arbitrary values are refused before credentials are sent. Its previous production default is retained for compatibility. Tests inject transport and make no external payment request. Preview sale/provider flags stay off; no merchant configuration or production endpoint was changed.

## Refund reconciliation implications

The supplier's [refund section](https://invoice4u.gitbook.io/invoice4u-docs/clearing-payments/process-api-request-v2#refunds) documents a synchronous request referencing the original provider payment. Its behavior means that requested amount cannot be treated as settled amount: Cardcom may reduce a request to the remaining balance, and UPay has a refund age limit. A credit invoice may be generated and emailed automatically when the original document can be found. Creating an accounting credit alone is not proof of money returned; see the separate [credit-invoice contract](https://invoice4u.gitbook.io/invoice4u-docs/documents/credit-invoices).

The current docs do not establish a general exactly-once refund key or an unambiguous recovery receipt for this merchant after a lost response. The next adapter must persist one attempt before transport, retain uncertain outcomes, reconcile actual credited amounts and original payment identity, and account for both customer refund requests and cumulative price-correction targets. It must not retry on timeout, sum revision targets, assume an HTTP 200 settled the requested amount, or issue a second credit document without checking the provider's result.

The cumulative request ledger and customer pending status are implemented. Actual refund dispatch/settlement, verified QA credentials, merchant-specific recovery evidence and the unified provider processor remain unfinished. No provider account, real customer, charge, refund or message was used in this research. Public documentation retrieval fingerprints and the original eight-test reproduction are retained in the release evidence.

## Checkout request and response

The [ProcessApiRequestV2 contract](https://invoice4u.gitbook.io/invoice4u-docs/clearing-payments/process-api-request-v2) specifies NIS on the wire and IsQaMode for QA. The adapter maps the product ILS currency and rejects invalid minor-unit amounts before transport. Both dictionary and historical array OpenInfo are supported; top-level and nested PaymentId must agree when both exist. Conflicting repeated keys are refused. An exact separately supplied clearing-log reference remains required: the documentation example containing only PaymentId is insufficient for this verifier and is not silently accepted. Ten of eleven original regression tests failed before repair; all 19 expanded checkout checks now pass with injected transport. This does not prove merchant account interoperability.

## Persisted reference verification

A successful provider log must also match any known PaymentId already saved on the checkout and payment row. The pending verifier now receives that ID; both current order and historical initial-payment paths reject contradictions. PostgreSQL independently rechecks saved references, exact amount/currency and the presence of the payment row before creating paid state or entitlement. Fourteen actual DEV assertions include two worker connections racing and customer-role refusal. These use synthetic provider coordinates, not merchant QA or live settlement.
