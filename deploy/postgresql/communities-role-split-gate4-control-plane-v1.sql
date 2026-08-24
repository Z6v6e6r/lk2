BEGIN;

CREATE SCHEMA phub_gate4_control;
REVOKE ALL ON SCHEMA phub_gate4_control FROM PUBLIC;

CREATE TABLE phub_gate4_control.control_binding_v1 (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  clock_subject_sha256 text NOT NULL CHECK (clock_subject_sha256 ~ '^[a-f0-9]{64}$'),
  ledger_subject_sha256 text NOT NULL CHECK (ledger_subject_sha256 ~ '^[a-f0-9]{64}$'),
  last_seen_unix_seconds bigint NOT NULL DEFAULT 0 CHECK (last_seen_unix_seconds >= 0),
  configured_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK (clock_subject_sha256 <> ledger_subject_sha256)
);

CREATE TABLE phub_gate4_control.consumption_receipt_v1 (
  authorization_sha256 text PRIMARY KEY CHECK (authorization_sha256 ~ '^[a-f0-9]{64}$'),
  request_id_sha256 text NOT NULL UNIQUE CHECK (request_id_sha256 ~ '^[a-f0-9]{64}$'),
  ledger_subject_sha256 text NOT NULL CHECK (ledger_subject_sha256 ~ '^[a-f0-9]{64}$'),
  attempt smallint NOT NULL CHECK (attempt = 1),
  consumed_at_unix_seconds bigint NOT NULL CHECK (consumed_at_unix_seconds >= 0),
  expires_at_unix_seconds bigint NOT NULL CHECK (expires_at_unix_seconds >= 0),
  CHECK (consumed_at_unix_seconds <= expires_at_unix_seconds)
);

CREATE VIEW phub_gate4_control.consumption_receipt_audit_v1 AS
SELECT
  authorization_sha256,
  request_id_sha256,
  ledger_subject_sha256,
  attempt,
  consumed_at_unix_seconds,
  expires_at_unix_seconds
FROM phub_gate4_control.consumption_receipt_v1;

CREATE FUNCTION phub_gate4_control.reject_receipt_mutation_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'PHUB_GATE4_CONTROL_RECEIPT_MUTATION_FORBIDDEN';
END;
$function$;

CREATE TRIGGER consumption_receipt_v1_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON phub_gate4_control.consumption_receipt_v1
FOR EACH STATEMENT
EXECUTE FUNCTION phub_gate4_control.reject_receipt_mutation_v1();

CREATE FUNCTION phub_gate4_control.read_time_v1(p_expected_clock_subject_sha256 text)
RETURNS TABLE("clockSubjectSha256" text, "unixSeconds" text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_clock_subject_sha256 text;
  v_last_seen_unix_seconds bigint;
  v_now_unix_seconds bigint;
BEGIN
  IF p_expected_clock_subject_sha256 IS NULL OR
     p_expected_clock_subject_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'PHUB_GATE4_CONTROL_CLOCK_SUBJECT_INVALID';
  END IF;

  SELECT binding.clock_subject_sha256, binding.last_seen_unix_seconds
  INTO STRICT v_clock_subject_sha256, v_last_seen_unix_seconds
  FROM phub_gate4_control.control_binding_v1 AS binding
  WHERE binding.singleton IS TRUE
  FOR UPDATE;

  IF v_clock_subject_sha256 <> p_expected_clock_subject_sha256 THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'PHUB_GATE4_CONTROL_CLOCK_SUBJECT_MISMATCH';
  END IF;

  v_now_unix_seconds :=
    pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp()))::bigint;
  IF v_now_unix_seconds < v_last_seen_unix_seconds THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'PHUB_GATE4_CONTROL_CLOCK_REGRESSION';
  END IF;

  UPDATE phub_gate4_control.control_binding_v1 AS binding
  SET last_seen_unix_seconds = v_now_unix_seconds
  WHERE binding.singleton IS TRUE;

  RETURN QUERY
  SELECT v_clock_subject_sha256, v_now_unix_seconds::text;
END;
$function$;

CREATE FUNCTION phub_gate4_control.consume_once_v1(
  p_expected_ledger_subject_sha256 text,
  p_authorization_sha256 text,
  p_request_id_sha256 text,
  p_expires_at_unix_seconds text,
  p_maximum_attempts smallint
)
RETURNS TABLE(
  "authorizationSha256" text,
  "requestIdSha256" text,
  "ledgerSubjectSha256" text,
  "attempt" smallint,
  "consumedAtUnixSeconds" text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_ledger_subject_sha256 text;
  v_last_seen_unix_seconds bigint;
  v_now_unix_seconds bigint;
  v_expires_at_unix_seconds bigint;
  v_inserted_rows bigint;
BEGIN
  IF p_expected_ledger_subject_sha256 IS NULL OR
     p_expected_ledger_subject_sha256 !~ '^[a-f0-9]{64}$' OR
     p_authorization_sha256 IS NULL OR
     p_authorization_sha256 !~ '^[a-f0-9]{64}$' OR
     p_request_id_sha256 IS NULL OR
     p_request_id_sha256 !~ '^[a-f0-9]{64}$' OR
     p_expires_at_unix_seconds IS NULL OR
     p_expires_at_unix_seconds !~ '^(0|[1-9][0-9]{0,15})$' OR
     p_maximum_attempts IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'PHUB_GATE4_CONTROL_CONSUMPTION_INPUT_INVALID';
  END IF;
  v_expires_at_unix_seconds := p_expires_at_unix_seconds::bigint;

  SELECT binding.ledger_subject_sha256, binding.last_seen_unix_seconds
  INTO STRICT v_ledger_subject_sha256, v_last_seen_unix_seconds
  FROM phub_gate4_control.control_binding_v1 AS binding
  WHERE binding.singleton IS TRUE
  FOR UPDATE;

  IF v_ledger_subject_sha256 <> p_expected_ledger_subject_sha256 THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'PHUB_GATE4_CONTROL_LEDGER_SUBJECT_MISMATCH';
  END IF;

  v_now_unix_seconds :=
    pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp()))::bigint;
  IF v_now_unix_seconds < v_last_seen_unix_seconds THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'PHUB_GATE4_CONTROL_CLOCK_REGRESSION';
  END IF;
  IF v_now_unix_seconds > v_expires_at_unix_seconds THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'PHUB_GATE4_CONTROL_AUTHORIZATION_EXPIRED';
  END IF;

  INSERT INTO phub_gate4_control.consumption_receipt_v1 (
    authorization_sha256,
    request_id_sha256,
    ledger_subject_sha256,
    attempt,
    consumed_at_unix_seconds,
    expires_at_unix_seconds
  )
  VALUES (
    p_authorization_sha256,
    p_request_id_sha256,
    v_ledger_subject_sha256,
    1,
    v_now_unix_seconds,
    v_expires_at_unix_seconds
  )
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted_rows = ROW_COUNT;
  IF v_inserted_rows <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'PHUB_GATE4_CONTROL_AUTHORIZATION_ALREADY_CONSUMED';
  END IF;

  UPDATE phub_gate4_control.control_binding_v1 AS binding
  SET last_seen_unix_seconds = v_now_unix_seconds
  WHERE binding.singleton IS TRUE;

  RETURN QUERY
  SELECT
    p_authorization_sha256,
    p_request_id_sha256,
    v_ledger_subject_sha256,
    1::smallint,
    v_now_unix_seconds::text;
END;
$function$;

REVOKE ALL ON TABLE phub_gate4_control.control_binding_v1 FROM PUBLIC;
REVOKE ALL ON TABLE phub_gate4_control.consumption_receipt_v1 FROM PUBLIC;
REVOKE ALL ON TABLE phub_gate4_control.consumption_receipt_audit_v1 FROM PUBLIC;
REVOKE ALL ON FUNCTION phub_gate4_control.reject_receipt_mutation_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION phub_gate4_control.read_time_v1(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION phub_gate4_control.consume_once_v1(text, text, text, text, smallint) FROM PUBLIC;

COMMENT ON SCHEMA phub_gate4_control IS
  'Gate 4 external fail-closed clock and append-only single-use ledger; binding and role grants are provisioned separately.';
COMMENT ON TABLE phub_gate4_control.control_binding_v1 IS
  'Exactly one independently pinned clock/ledger binding; an absent row keeps every adapter fail closed.';
COMMENT ON TABLE phub_gate4_control.consumption_receipt_v1 IS
  'Append-only Gate 4 consumption receipts; authorization and request identities are independently unique.';

COMMIT;
