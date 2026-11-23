-- MVP-001 S11 pass 2 (15 of 16): correction D3 of the S11 architecture verification: a capture requested on a
-- confirmed authorization re-runs the four-way production gate (MVP-001 Packet section 2 rule 4 and section 4 "four-way
-- gate"; MBS sections 12 and 19; IMP section 29; TA section 32 F1-F2; PM section 1 INV-11).
--
-- No relation, column, policy type or seed is added (Packet rules 8, 10 and 16).
--
-- payment_confirm_authorization (S8 20261124020000, replaced forward with its signature, volatility, security mode,
-- search_path, owner, privileges and comment; every other rule unchanged) requests the capture of a newly authorized
-- payment when its governing flow captures at_authorization, or at_attorney_acceptance once the Request is already
-- accepted (a late authorization after the acceptance). Until now that capture was requested without the four-way
-- gate. From now on, in a production-class database, payment_capture_gate_problem re-checks the payment's own recorded
-- versions exactly as media_production_problem (S9, unchanged) does: each of the seven recorded versions (referral and
-- fee jurisdiction-wide; payment_flow, payment, engagement, cancellation and refund under the payment's Regulatory
-- Mode) must not be development configuration and must pass production_financial_gate for the payment's jurisdiction
-- now (environment production, jurisdiction live, an approved active policy selectable, an unrevoked launch
-- authorization; three of four is not enough). A missing version fails closed. When the gate is closed:
-- - the payment stays authorized (the authorization itself is a provider fact and is recorded);
-- - no capture is requested and no capture job is created;
-- - one critical Reconciliation Exception of type capture_gate_closed (financial family) is opened about the payment
--   (source and canonical object the payment; evidence: the problem code, the configured capture moment, the Request
--   and payment states), audited once by payment_open_exception. Whether to release or keep holding the authorization
--   stays a human decision of finance staff (PM INV-11): nothing is released automatically.
-- In a development or staging database nothing changes (the gate applies to production-class databases only, as
-- for every other production-gated operation).

-- The four-way gate problem of a payment's recorded versions (internal): null when the database is not
-- production-class or every recorded version passes; otherwise development_policy or production_gate_closed.
create function public.payment_capture_gate_problem(p_payment public.payment_transactions)
returns text
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $function$
  select public.media_production_problem(
    p_payment.jurisdiction_id,
    jsonb_build_array(
      jsonb_build_object('policy_type_code', 'referral', 'policy_version_id', p_payment.referral_policy_version_id,
                         'regulatory_mode_id', null),
      jsonb_build_object('policy_type_code', 'fee', 'policy_version_id', p_payment.fee_policy_version_id,
                         'regulatory_mode_id', null),
      jsonb_build_object('policy_type_code', 'payment_flow', 'policy_version_id', p_payment.payment_flow_policy_version_id,
                         'regulatory_mode_id', p_payment.regulatory_mode_id),
      jsonb_build_object('policy_type_code', 'payment', 'policy_version_id', p_payment.payment_policy_version_id,
                         'regulatory_mode_id', p_payment.regulatory_mode_id),
      jsonb_build_object('policy_type_code', 'engagement', 'policy_version_id', p_payment.engagement_policy_version_id,
                         'regulatory_mode_id', p_payment.regulatory_mode_id),
      jsonb_build_object('policy_type_code', 'cancellation', 'policy_version_id', p_payment.cancellation_policy_version_id,
                         'regulatory_mode_id', p_payment.regulatory_mode_id),
      jsonb_build_object('policy_type_code', 'refund', 'policy_version_id', p_payment.refund_policy_version_id,
                         'regulatory_mode_id', p_payment.regulatory_mode_id)
    ),
    clock_timestamp()
  );
$function$;

-- Records a confirmed authorization (S8, with the D3 gate before the capture request).
create or replace function public.payment_confirm_authorization(
  p_payment public.payment_transactions,
  p_reference text,
  p_amount bigint,
  p_currency text,
  p_source_type text,
  p_source_id uuid,
  p_actor_type text
)
returns text
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_fee public.fee_calculations;
  v_after public.payment_transactions;
  v_parameters jsonb;
  v_request public.consultation_requests;
  v_problem text;
begin
  select c.* into v_fee from public.fee_calculations as c where c.id = p_payment.fee_calculation_id;
  if p_amount is distinct from v_fee.total_client_amount_minor or p_currency is distinct from p_payment.currency_code::text then
    update public.payment_transactions as pt
    set state = 'release_pending',
        authorized_at = clock_timestamp(),
        amount_authorized_minor = p_amount,
        provider_payment_reference = p_reference
    where pt.id = p_payment.id
    returning pt.* into v_after;
    perform public.payment_audit(null, p_actor_type, 'payment.release_requested', p_payment, v_after, 'amount_mismatch');
    perform public.payment_enqueue('payment.release', 'payment_transaction', p_payment.id);
    perform public.payment_open_exception(
      p_source_type, p_source_id, p_payment.id, 'amount_mismatch', 'critical',
      jsonb_build_object(
        'expected_amount_minor', v_fee.total_client_amount_minor,
        'expected_currency_code', p_payment.currency_code,
        'observed_amount_minor', p_amount,
        'observed_currency_code', p_currency
      )
    );
    return 'contradiction';
  end if;
  update public.payment_transactions as pt
  set state = 'authorized',
      authorized_at = clock_timestamp(),
      amount_authorized_minor = p_amount,
      provider_payment_reference = p_reference
  where pt.id = p_payment.id
  returning pt.* into v_after;
  perform public.payment_audit(null, p_actor_type, 'payment.authorized', p_payment, v_after, 'authorization_confirmed');
  perform public.payment_advance_request(v_after);
  select r.* into v_request from public.consultation_requests as r where r.id = v_after.consultation_request_id;
  select v.parameters into v_parameters from public.policy_versions as v where v.id = v_after.payment_flow_policy_version_id;
  if public.payment_flow_parameters_valid(v_parameters)
     and (
       (v_parameters -> v_request.request_path ->> 'capture') = 'at_authorization'
       or (v_request.state = 'accepted' and (v_parameters -> v_request.request_path ->> 'capture') = 'at_attorney_acceptance')
     ) then
    -- MVP-001 S11 (D3): in a production-class database the four-way gate is re-run for the payment's recorded
    -- versions before the capture is requested; a closed gate requests nothing and opens a critical review item.
    v_problem := public.payment_capture_gate_problem(v_after);
    if v_problem is null then
      perform public.payment_request_capture(v_after.id);
    else
      perform public.payment_open_exception(
        'payment_transaction', v_after.id, v_after.id, 'capture_gate_closed', 'critical',
        jsonb_build_object(
          'problem', v_problem,
          'capture', v_parameters -> v_request.request_path ->> 'capture',
          'request_state', v_request.state,
          'payment_state', v_after.state
        )
      );
    end if;
  end if;
  return 'applied';
end;
$function$;

revoke all on function public.payment_capture_gate_problem(public.payment_transactions)
  from public, anon, authenticated, service_role;

comment on function public.payment_capture_gate_problem(public.payment_transactions) is
  'MVP-001 S11 (internal; D3): the four-way production gate problem of a payment''s seven recorded versions (null outside a production-class database or when every version passes; development_policy or production_gate_closed otherwise), as media_production_problem decides. Executable by no API role.';
