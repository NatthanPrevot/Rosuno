-- MVP-001 S7 (1 of 2): payment, ledger, reconciliation and provider-receipt integrity on the existing Physical 1J
-- relations (MVP-001 Packet S7 "payment state with FP-1 provenance", "ledger posting", "reconciliation exceptions",
-- "webhook authenticity, receipt uniqueness and replay protection"; MBS section 12 financial invariants; PS sections
-- 22.2, 22.3, 22.5, 23.1, 32 and 33; PM section 1 INV-1, INV-3, INV-7, INV-9, INV-11, INV-13 and section 9 rows 26-30;
-- TA sections 16.1, 26, 52 and 53; FP-1 sections 2-8 and 13).
--
-- No relation or column is added (Packet rule 16; PS sections 22-23 and the FP-1 provenance columns exist since
-- 20260919000112), no policy type is added (FP-1 section 1 types exist since 20261117010000), public.payouts is not
-- created (FP-1 section 11) and nothing settles G-1 to G-5. This migration adds implementation constraints, indexes,
-- guard triggers and one capability catalog row (as S1 and S2 did), and narrows service_role so from now on every
-- payment, ledger, reconciliation and receipt write is one of the S7 database functions (20261123020000).
--
-- Payment Transaction state vocabulary (PS section 22.2 leaves state free text; the values come from PM section 9
-- rows 26-30, PM section 3 note "authorization release/reversal", TA section 52's explicit intermediate states and TA
-- section 16.1's authorize / capture / release / refund operations):
-- - pending_authorization: created; the hosted provider checkout is being prepared or awaits the client;
-- - authorized: an authorization of the Fee Calculation's total in its currency is confirmed;
-- - failed: the authorization failed (PM row 26);
-- - cancelled: the attempt ended before any authorization existed (checkout expired, or released before one);
-- - release_pending: Rosuno asked the provider to release the attempt (TA section 52 intermediate state);
-- - authorization_released: a confirmed authorization was released, nothing captured (PM rows 3-5, 8-10);
-- - capture_pending: Rosuno asked the provider to capture (TA section 52 "capture requested");
-- - captured: the capture is confirmed;
-- - capture_failed: the capture failed definitively (PM row 27; with a Reconciliation Exception);
-- - refund_pending: Rosuno asked the provider to refund (one refund in flight at a time);
-- - partially_refunded / fully_refunded: PM rows 28 and 29;
-- - charged_back: a dispute was observed (PM row 30); amounts are unchanged and the outcome stays separate.
-- Lifecycle (every role, the owner included): created pending_authorization with no provider facts; pending_authorization
-- -> authorized | failed | cancelled | release_pending; authorized -> capture_pending | release_pending;
-- release_pending -> cancelled | authorization_released; capture_pending -> captured | capture_failed; captured ->
-- refund_pending | charged_back; refund_pending -> captured | partially_refunded | fully_refunded | charged_back;
-- partially_refunded -> refund_pending | charged_back; fully_refunded -> charged_back. failed, cancelled,
-- authorization_released, capture_failed and charged_back are terminal. Provider facts are recorded once (authorized
-- amount and time, captured amount and time, failure time); the refunded amount only grows and only while a refund
-- is pending; the provider reference is set once and replaced at most once, by the provider's payment reference, in
-- the update that records the authorization. Amounts: captured <= authorized, refunded <= captured. A payment is
-- never deleted or truncated. The FP-1 provenance columns stay immutable (the P1 integrity trigger) and the currency
-- stays the Fee Calculation's (P1; PS section 33 currency integrity).
--
-- Ledger (PS section 22.3, append-only for every role; DM section 10 "a correction is another entry"): entry types
-- client_payment, attorney_share, platform_fee, client_fee and other_required_fee (the immutable Fee Calculation
-- components, PS section 22.1), directions debit and credit, reason codes payment_captured and payment_refunded; a
-- capture posts client_payment debit (the total) against credits of each component, a refund posts the opposite
-- directions (a reversal, never an edit). Every entry belongs to a payment transaction, has a positive amount, a
-- source reference capture:<payment> or refund:<refund request>, and posts once per (payment, entry type, source
-- reference). Its currency is the payment's (P1). payout_id stays NULL-only (FP-1 section 11).
--
-- Reconciliation Exceptions (PS section 22.5; TA section 26): status open or resolved; severity low, medium, high or
-- critical; lower-snake source, canonical and exception types; evidence is a JSON object; an exception is never
-- deleted, its detection facts never change, it is assigned only while open and resolved once with notes; at most
-- one open exception per exception type and source.
--
-- External Event Receipts (PS section 23.1; PS section 34 provider idempotency: the P1 unique (provider_code,
-- provider_event_reference) key): lower-snake provider code, dotted event type, a sha256: payload digest and a JSON
-- object minimal payload (policy-minimized: never the raw provider payload). A receipt is never deleted; it is
-- recorded 'received' and moves once to its processing outcome (applied, no_effect, stale, contradiction, unmatched,
-- ignored) with its processing time; nothing else changes.
--
-- Capability catalog: manage_financial_operations (staff finance workspace; grants stay configuration rows).

-- ---------------------------------------------------------------------------
-- Capability catalog (grants stay configuration rows).
-- ---------------------------------------------------------------------------

insert into public.capability_definitions (capability_code)
values ('manage_financial_operations');

-- ---------------------------------------------------------------------------
-- Payment Transactions.
-- ---------------------------------------------------------------------------

alter table public.payment_transactions
  add constraint payment_transactions_state_v1_check
    check (state in (
      'pending_authorization', 'authorized', 'failed', 'cancelled', 'release_pending',
      'authorization_released', 'capture_pending', 'captured', 'capture_failed', 'refund_pending',
      'partially_refunded', 'fully_refunded', 'charged_back'
    )),
  add constraint payment_transactions_provider_code_v1_check
    check (provider_code collate "C" ~ '^[a-z][a-z0-9_]{1,31}$'),
  add constraint payment_transactions_provider_reference_v1_check
    check (provider_payment_reference is null or provider_payment_reference collate "C" ~ '^[A-Za-z0-9_]{3,255}$'),
  add constraint payment_transactions_authorization_facts_v1_check
    check ((authorized_at is null) = (amount_authorized_minor is null)),
  add constraint payment_transactions_capture_facts_v1_check
    check ((captured_at is null) = (amount_captured_minor is null)),
  add constraint payment_transactions_amounts_v1_check
    check (
      (amount_captured_minor is null or (amount_authorized_minor is not null and amount_captured_minor <= amount_authorized_minor))
      and amount_refunded_minor <= coalesce(amount_captured_minor, 0)
    ),
  add constraint payment_transactions_state_facts_v1_check
    check (
      (state <> 'pending_authorization' or (authorized_at is null and captured_at is null))
      and (authorized_at is null or provider_payment_reference is not null)
      and (state <> 'cancelled' or authorized_at is null)
      and (state not in (
             'authorized', 'authorization_released', 'capture_pending', 'captured', 'capture_failed',
             'refund_pending', 'partially_refunded', 'fully_refunded', 'charged_back'
           ) or authorized_at is not null)
      and (state not in ('captured', 'refund_pending', 'partially_refunded', 'fully_refunded', 'charged_back')
           or captured_at is not null)
      and (state not in (
             'pending_authorization', 'authorized', 'failed', 'cancelled', 'release_pending',
             'authorization_released', 'capture_pending', 'capture_failed'
           ) or captured_at is null)
      and ((failed_at is not null) = (state in ('failed', 'capture_failed')))
      and (state <> 'captured' or amount_refunded_minor = 0)
      and (state <> 'partially_refunded' or (amount_refunded_minor > 0 and amount_refunded_minor < amount_captured_minor))
      and (state <> 'fully_refunded' or amount_refunded_minor = amount_captured_minor)
    );

-- One live attempt per Request: every attempt that may still hold or move funds blocks a second one.
create unique index payment_transactions_one_live_attempt_idx
  on public.payment_transactions (consultation_request_id)
  where state not in ('failed', 'cancelled', 'authorization_released');

-- A provider object belongs to at most one payment transaction.
create unique index payment_transactions_provider_reference_unique_idx
  on public.payment_transactions (provider_code, provider_payment_reference)
  where provider_payment_reference is not null;

create index payment_transactions_state_created_idx
  on public.payment_transactions (state, created_at desc, id);

create function public.payment_transaction_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'payment transactions are never deleted'
      using errcode = '55000';
  end if;
  if tg_op = 'INSERT' then
    if new.state is distinct from 'pending_authorization'
       or new.amount_authorized_minor is not null
       or new.amount_captured_minor is not null
       or new.amount_refunded_minor is distinct from 0
       or new.provider_payment_reference is not null
       or new.authorized_at is not null
       or new.captured_at is not null
       or new.failed_at is not null
       or new.consultation_id is not null then
      raise exception 'a payment transaction is created pending authorization, with no provider facts'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if (old.amount_authorized_minor is not null and new.amount_authorized_minor is distinct from old.amount_authorized_minor)
     or (old.authorized_at is not null and new.authorized_at is distinct from old.authorized_at)
     or (old.amount_captured_minor is not null and new.amount_captured_minor is distinct from old.amount_captured_minor)
     or (old.captured_at is not null and new.captured_at is distinct from old.captured_at)
     or (old.failed_at is not null and new.failed_at is distinct from old.failed_at)
     or new.amount_refunded_minor < old.amount_refunded_minor then
    raise exception 'payment provider facts are recorded once and the refunded amount only grows'
      using errcode = '55000';
  end if;
  if old.provider_payment_reference is not null
     and new.provider_payment_reference is distinct from old.provider_payment_reference
     and not (
       old.authorized_at is null
       and new.authorized_at is not null
       and new.provider_payment_reference is not null
     ) then
    raise exception 'the provider reference is set once and replaced only when the authorization is recorded'
      using errcode = '55000';
  end if;
  if new.amount_refunded_minor <> old.amount_refunded_minor and old.state is distinct from 'refund_pending' then
    raise exception 'a refunded amount is recorded only while a refund is pending'
      using errcode = '55000';
  end if;
  if old.state in ('failed', 'cancelled', 'authorization_released', 'capture_failed', 'charged_back')
     and (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
    raise exception 'a payment transaction that is % is terminal', old.state
      using errcode = '55000';
  end if;
  if new.state is distinct from old.state and not (
       (old.state = 'pending_authorization' and new.state in ('authorized', 'failed', 'cancelled', 'release_pending'))
       or (old.state = 'authorized' and new.state in ('capture_pending', 'release_pending'))
       or (old.state = 'release_pending' and new.state in ('cancelled', 'authorization_released'))
       or (old.state = 'capture_pending' and new.state in ('captured', 'capture_failed'))
       or (old.state = 'captured' and new.state in ('refund_pending', 'charged_back'))
       or (old.state = 'refund_pending'
           and new.state in ('captured', 'partially_refunded', 'fully_refunded', 'charged_back'))
       or (old.state = 'partially_refunded' and new.state in ('refund_pending', 'charged_back'))
       or (old.state = 'fully_refunded' and new.state = 'charged_back')
     ) then
    raise exception 'payment transaction transition % -> % is not permitted', old.state, new.state
      using errcode = '55000';
  end if;
  -- Without a state change only the provider reference (set once, or replaced with the authorization), the
  -- authorization facts of an attempt whose release is pending (a late authorization the release will undo) and
  -- the Consultation association change.
  if new.state = old.state
     and (
       (to_jsonb(new) - array['updated_at', 'provider_payment_reference', 'consultation_id', 'authorized_at',
                              'amount_authorized_minor'])
       is distinct from
       (to_jsonb(old) - array['updated_at', 'provider_payment_reference', 'consultation_id', 'authorized_at',
                              'amount_authorized_minor'])
       or (old.state <> 'release_pending'
           and (new.authorized_at is distinct from old.authorized_at
                or new.amount_authorized_minor is distinct from old.amount_authorized_minor))
     ) then
    raise exception 'a payment transaction changes its facts only with its state'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

create trigger payment_transactions_lifecycle_guard
before insert or update or delete on public.payment_transactions
for each row
execute function public.payment_transaction_lifecycle();

create trigger payment_transactions_no_truncate
before truncate on public.payment_transactions
for each statement
execute function public.payment_transaction_lifecycle();

-- ---------------------------------------------------------------------------
-- Ledger Entries (append-only for every role since P1; vocabulary and idempotent posting here).
-- ---------------------------------------------------------------------------

alter table public.ledger_entries
  add constraint ledger_entries_payment_transaction_v1_check
    check (payment_transaction_id is not null),
  add constraint ledger_entries_entry_type_v1_check
    check (entry_type in ('client_payment', 'attorney_share', 'platform_fee', 'client_fee', 'other_required_fee')),
  add constraint ledger_entries_direction_v1_check
    check (direction in ('debit', 'credit')),
  add constraint ledger_entries_reason_code_v1_check
    check (reason_code in ('payment_captured', 'payment_refunded')),
  add constraint ledger_entries_amount_positive_v1_check
    check (amount_minor > 0),
  add constraint ledger_entries_source_reference_v1_check
    check (source_reference collate "C"
           ~ '^(capture|refund):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  add constraint ledger_entries_metadata_v1_check
    check (metadata is null or jsonb_typeof(metadata) = 'object');

create unique index ledger_entries_posting_unique_idx
  on public.ledger_entries (payment_transaction_id, entry_type, source_reference);

create function public.ledger_entries_no_truncate()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  raise exception 'Ledger Entries are append-only and never truncated'
    using errcode = '55000';
end;
$function$;

create trigger ledger_entries_no_truncate
before truncate on public.ledger_entries
for each statement
execute function public.ledger_entries_no_truncate();

-- ---------------------------------------------------------------------------
-- Reconciliation Exceptions.
-- ---------------------------------------------------------------------------

alter table public.reconciliation_exceptions
  add constraint reconciliation_exceptions_status_v1_check
    check (status in ('open', 'resolved')),
  add constraint reconciliation_exceptions_severity_v1_check
    check (severity in ('low', 'medium', 'high', 'critical')),
  add constraint reconciliation_exceptions_types_v1_check
    check (
      source_type collate "C" ~ '^[a-z][a-z0-9_]{1,63}$'
      and canonical_type collate "C" ~ '^[a-z][a-z0-9_]{1,63}$'
      and exception_type collate "C" ~ '^[a-z][a-z0-9_]{1,63}$'
    ),
  add constraint reconciliation_exceptions_evidence_v1_check
    check (jsonb_typeof(evidence_reference) = 'object'),
  add constraint reconciliation_exceptions_resolution_v1_check
    check (
      (status = 'open' and resolved_at is null and resolution_notes is null)
      or (
        status = 'resolved'
        and resolved_at is not null
        and resolution_notes is not null
        and char_length(resolution_notes) between 1 and 2000
        and btrim(resolution_notes) = resolution_notes
      )
    );

create unique index reconciliation_exceptions_open_source_unique_idx
  on public.reconciliation_exceptions (exception_type, source_type, source_id)
  where status = 'open' and source_id is not null;

create index reconciliation_exceptions_detected_idx
  on public.reconciliation_exceptions (status, detected_at desc, id);

create index reconciliation_exceptions_canonical_idx
  on public.reconciliation_exceptions (canonical_type, canonical_id);

create function public.reconciliation_exception_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'reconciliation exceptions are never deleted'
      using errcode = '55000';
  end if;
  if tg_op = 'INSERT' then
    if new.status is distinct from 'open' or new.assigned_to_user_id is not null then
      raise exception 'a reconciliation exception is created open and unassigned'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id
     or new.source_type is distinct from old.source_type
     or new.source_id is distinct from old.source_id
     or new.canonical_type is distinct from old.canonical_type
     or new.canonical_id is distinct from old.canonical_id
     or new.exception_type is distinct from old.exception_type
     or new.severity is distinct from old.severity
     or new.detected_at is distinct from old.detected_at
     or new.evidence_reference is distinct from old.evidence_reference
     or new.created_at is distinct from old.created_at then
    raise exception 'a reconciliation exception keeps its detection facts'
      using errcode = '55000';
  end if;
  if old.status = 'resolved' then
    raise exception 'a resolved reconciliation exception is final'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

create trigger reconciliation_exceptions_lifecycle_guard
before insert or update or delete on public.reconciliation_exceptions
for each row
execute function public.reconciliation_exception_lifecycle();

create trigger reconciliation_exceptions_no_truncate
before truncate on public.reconciliation_exceptions
for each statement
execute function public.reconciliation_exception_lifecycle();

-- ---------------------------------------------------------------------------
-- External Event Receipts.
-- ---------------------------------------------------------------------------

alter table public.external_event_receipts
  add constraint external_event_receipts_provider_code_v1_check
    check (provider_code collate "C" ~ '^[a-z][a-z0-9_]{1,31}$'),
  add constraint external_event_receipts_event_reference_v1_check
    check (provider_event_reference collate "C" ~ '^[A-Za-z0-9_]{3,255}$'),
  add constraint external_event_receipts_event_type_v1_check
    check (event_type collate "C" ~ '^[a-z][a-z0-9_.]{2,99}$'),
  add constraint external_event_receipts_processing_state_v1_check
    check (processing_state in (
      'received', 'applied', 'no_effect', 'stale', 'contradiction', 'unmatched', 'ignored'
    )),
  add constraint external_event_receipts_processed_v1_check
    check ((processing_state = 'received') = (processed_at is null)),
  add constraint external_event_receipts_digest_v1_check
    check (payload_digest is not null and payload_digest collate "C" ~ '^sha256:[0-9a-f]{64}$'),
  add constraint external_event_receipts_minimal_payload_v1_check
    check (minimal_payload is not null and jsonb_typeof(minimal_payload) = 'object'),
  add constraint external_event_receipts_correlation_v1_check
    check (
      correlation_reference is null
      or correlation_reference collate "C" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    );

create index external_event_receipts_correlation_idx
  on public.external_event_receipts (correlation_reference, received_at desc)
  where correlation_reference is not null;

create function public.external_event_receipt_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'external event receipts are never deleted'
      using errcode = '55000';
  end if;
  if tg_op = 'INSERT' then
    if new.processing_state is distinct from 'received' or new.processed_at is not null then
      raise exception 'an external event receipt is recorded as received'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if old.processing_state is distinct from 'received'
     or new.processing_state = 'received'
     or (to_jsonb(new) - array['processing_state', 'processed_at', 'correlation_reference'])
        is distinct from (to_jsonb(old) - array['processing_state', 'processed_at', 'correlation_reference'])
     or (old.correlation_reference is not null
         and new.correlation_reference is distinct from old.correlation_reference) then
    raise exception 'an external event receipt records its processing outcome once and nothing else changes'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

create trigger external_event_receipts_lifecycle_guard
before insert or update or delete on public.external_event_receipts
for each row
execute function public.external_event_receipt_lifecycle();

create trigger external_event_receipts_no_truncate
before truncate on public.external_event_receipts
for each statement
execute function public.external_event_receipt_lifecycle();

-- ---------------------------------------------------------------------------
-- Privileges: writes become function-only (Packet section 1 RLS impact); service_role keeps SELECT only. No API
-- role reads these relations directly: clients, attorneys and staff read through the S7 functions.
-- ---------------------------------------------------------------------------

revoke insert, update, delete, truncate, references, trigger on table
  public.payment_transactions,
  public.ledger_entries,
  public.reconciliation_exceptions,
  public.external_event_receipts
from public, anon, authenticated, service_role;

revoke all on function public.payment_transaction_lifecycle()
  from public, anon, authenticated, service_role;
revoke all on function public.ledger_entries_no_truncate()
  from public, anon, authenticated, service_role;
revoke all on function public.reconciliation_exception_lifecycle()
  from public, anon, authenticated, service_role;
revoke all on function public.external_event_receipt_lifecycle()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------

comment on function public.payment_transaction_lifecycle() is
  'MVP-001 S7: a Payment Transaction is never deleted or truncated; it is created pending_authorization without provider facts; its state moves only along the S7 lifecycle (PM section 9; TA section 52 intermediate states); provider facts are recorded once, the refunded amount only grows while a refund is pending, and the provider reference is set once and replaced only with the authorization; terminal states never change.';
comment on function public.ledger_entries_no_truncate() is
  'MVP-001 S7: Ledger Entries are never truncated (P1 already refuses update and delete for every role).';
comment on function public.reconciliation_exception_lifecycle() is
  'MVP-001 S7: a Reconciliation Exception is never deleted; it is created open and unassigned, keeps its detection facts, is assigned only while open and is resolved once.';
comment on function public.external_event_receipt_lifecycle() is
  'MVP-001 S7: an External Event Receipt is never deleted; it is recorded received and moves once to its processing outcome; nothing else changes.';
comment on column public.payment_transactions.state is
  'MVP-001 S7 vocabulary: pending_authorization, authorized, failed, cancelled, release_pending, authorization_released, capture_pending, captured, capture_failed, refund_pending, partially_refunded, fully_refunded, charged_back (PM section 9 rows 26-30; TA section 52). Rosuno truth; provider status is only an observation (PS section 38).';
comment on column public.payment_transactions.provider_payment_reference is
  'MVP-001 S7: the provider''s hosted checkout reference until an authorization is recorded, then the provider''s payment reference (set once, replaced once). Never card data.';
comment on column public.ledger_entries.entry_type is
  'MVP-001 S7: client_payment, attorney_share, platform_fee, client_fee or other_required_fee (the Fee Calculation components); a capture posts client_payment debit against component credits and a refund the reverse.';
