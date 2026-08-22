alter table public.payments
  add column if not exists payment_return_token_hash text,
  add column if not exists payment_return_token_expires_at timestamptz,
  add column if not exists payment_return_token_consumed_at timestamptz;

create unique index if not exists payments_return_token_hash_unique_idx
  on public.payments(payment_return_token_hash)
  where payment_return_token_hash is not null;

comment on column public.payments.payment_return_token_hash is
  'SHA-256 hash of a one-time token embedded in the provider ReturnUrl.';
