alter table public.payments
  add column if not exists provider_checkout_created_at timestamptz;

comment on column public.payments.provider_checkout_created_at is
  'Server timestamp used to expire and regenerate short-lived Invoice4u checkout URLs.';
