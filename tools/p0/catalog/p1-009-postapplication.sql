BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';
WITH
target_tables(schema_name, table_name) AS (
  VALUES
    ('public','ai_suggestions'),
    ('public','application_sessions'),
    ('public','attorney_profiles'),
    ('public','availability_rules'),
    ('public','blackouts'),
    ('public','bookability_evaluations'),
    ('public','bookings'),
    ('public','capability_definitions'),
    ('public','capability_grants'),
    ('public','client_profiles'),
    ('public','consultation_requests'),
    ('public','consultations'),
    ('public','discipline_records'),
    ('public','eligibility_evaluations'),
    ('public','engagements'),
    ('public','instant_availability_intents'),
    ('public','insurance_records'),
    ('public','intakes'),
    ('public','jurisdiction_assessments'),
    ('public','jurisdiction_regulatory_modes'),
    ('public','jurisdictions'),
    ('public','launch_authorizations'),
    ('public','launch_gate_evaluations'),
    ('public','launch_gates'),
    ('public','licenses'),
    ('public','media_rooms'),
    ('public','media_sessions'),
    ('public','policy_authority_references'),
    ('public','policy_types'),
    ('public','policy_versions'),
    ('public','practice_area_authorisations'),
    ('public','practice_areas'),
    ('public','referral_eligible_pool_entries'),
    ('public','referral_presentations'),
    ('public','referrals'),
    ('public','regulatory_modes'),
    ('public','service_areas'),
    ('public','session_participation_records'),
    ('public','slot_holds'),
    ('public','staff_profiles'),
    ('public','users'),
    ('public','verification_evidence'),
    ('public','verification_evidence_subjects'),
    ('public','resources'),
    ('public','documents'),
    ('public','voice_memos'),
    ('public','resource_sharing_grants'),
    ('public','messages'),
    ('public','notifications'),
    ('public','notification_attempts'),
    ('public','operational_jobs')
),
target_functions(schema_name, function_name, identity_args) AS (
  VALUES
    ('public','enforce_bookability_eligibility_consistency',''),
    ('public','enforce_consultation_relationships',''),
    ('public','enforce_consultation_request_relationships',''),
    ('public','enforce_instant_intent_session_binding',''),
    ('public','enforce_jurisdiction_live_authorization',''),
    ('public','enforce_policy_authority_provenance',''),
    ('public','enforce_request_hold_consistency',''),
    ('public','enforce_scheduling_conflicts',''),
    ('public','enforce_session_participant_relationship',''),
    ('public','has_manage_attorney_verification_scope','required_jurisdiction uuid, allow_any_jurisdiction boolean'),
    ('public','rls_auto_enable',''),
    ('public','set_updated_at',''),
    ('public','enforce_voice_memo_consistency',''),
    ('public','enforce_message_relationships',''),
    ('public','enforce_resource_sharing_grant_integrity',''),
    ('public','has_resource_metadata_access','required_resource_id uuid')
),
principals(principal, role_name) AS (
  VALUES
    ('PUBLIC',NULL::name),
    ('anon','anon'::name),
    ('authenticated','authenticated'::name),
    ('service_role','service_role'::name),
    ('owner',NULL::name)
),
catalog_rows AS (
  SELECT 'table' category, n.nspname||'.'||c.relname identity,
    jsonb_build_object(
      'schema',n.nspname,'name',c.relname,'kind',
      CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned_table' ELSE c.relkind::text END,
      'owner',pg_get_userbyid(c.relowner),'comment',obj_description(c.oid,'pg_class')
    ) data
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN target_tables t ON t.schema_name=n.nspname AND t.table_name=c.relname
  WHERE c.relkind IN ('r','p')

  UNION ALL
  SELECT 'column',n.nspname||'.'||c.relname||'.'||a.attname,
    jsonb_build_object(
      'schema',n.nspname,'table',c.relname,'name',a.attname,'ordinal',a.attnum,
      'canonical_type',format_type(a.atttypid,a.atttypmod),'nullable',NOT a.attnotnull,
      'default_expression',CASE WHEN d.oid IS NULL THEN NULL ELSE pg_get_expr(d.adbin,d.adrelid) END
    )
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN target_tables t ON t.schema_name=n.nspname AND t.table_name=c.relname
  LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
  WHERE a.attnum>0 AND NOT a.attisdropped

  UNION ALL
  SELECT 'constraint',n.nspname||'.'||r.relname||'.'||con.conname,
    jsonb_build_object(
      'schema',n.nspname,'table',r.relname,'name',con.conname,'type',con.contype::text,
      'columns',COALESCE((SELECT jsonb_agg(a.attname ORDER BY u.ord) FROM unnest(con.conkey) WITH ORDINALITY u(attnum,ord) JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=u.attnum),'[]'::jsonb),
      'referenced_schema',rn.nspname,'referenced_table',rr.relname,
      'referenced_columns',COALESCE((SELECT jsonb_agg(a.attname ORDER BY u.ord) FROM unnest(con.confkey) WITH ORDINALITY u(attnum,ord) JOIN pg_attribute a ON a.attrelid=con.confrelid AND a.attnum=u.attnum),'[]'::jsonb),
      'definition',pg_get_constraintdef(con.oid,true)
    )
  FROM pg_constraint con JOIN pg_class r ON r.oid=con.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
  JOIN target_tables t ON t.schema_name=n.nspname AND t.table_name=r.relname
  LEFT JOIN pg_class rr ON rr.oid=con.confrelid LEFT JOIN pg_namespace rn ON rn.oid=rr.relnamespace

  UNION ALL
  SELECT 'index',n.nspname||'.'||r.relname||'.'||i.relname,
    jsonb_build_object('schema',n.nspname,'table',r.relname,'name',i.relname,'definition',pg_get_indexdef(i.oid))
  FROM pg_index x JOIN pg_class r ON r.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid
  JOIN pg_namespace n ON n.oid=r.relnamespace JOIN target_tables t ON t.schema_name=n.nspname AND t.table_name=r.relname

  UNION ALL
  SELECT 'foreign_key',n.nspname||'.'||r.relname||'.'||con.conname,
    jsonb_build_object(
      'schema',n.nspname,'table',r.relname,'name',con.conname,
      'columns',(SELECT jsonb_agg(a.attname ORDER BY u.ord) FROM unnest(con.conkey) WITH ORDINALITY u(attnum,ord) JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=u.attnum),
      'referenced_schema',rn.nspname,'referenced_table',rr.relname,
      'referenced_columns',(SELECT jsonb_agg(a.attname ORDER BY u.ord) FROM unnest(con.confkey) WITH ORDINALITY u(attnum,ord) JOIN pg_attribute a ON a.attrelid=con.confrelid AND a.attnum=u.attnum),
      'definition',pg_get_constraintdef(con.oid,true)
    )
  FROM pg_constraint con JOIN pg_class r ON r.oid=con.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
  JOIN target_tables t ON t.schema_name=n.nspname AND t.table_name=r.relname
  JOIN pg_class rr ON rr.oid=con.confrelid JOIN pg_namespace rn ON rn.oid=rr.relnamespace
  WHERE con.contype='f'

  UNION ALL
  SELECT 'rls',n.nspname||'.'||c.relname,
    jsonb_build_object('schema',n.nspname,'table',c.relname,'enabled',c.relrowsecurity,'forced',c.relforcerowsecurity)
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN target_tables t ON t.schema_name=n.nspname AND t.table_name=c.relname

  UNION ALL
  SELECT 'policy',n.nspname||'.'||c.relname||'.'||p.polname,
    jsonb_build_object(
      'schema',n.nspname,'table',c.relname,'name',p.polname,
      'command',CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END,
      'roles',(SELECT jsonb_agg(CASE WHEN role_oid=0 THEN 'PUBLIC' ELSE pg_get_userbyid(role_oid) END ORDER BY CASE WHEN role_oid=0 THEN 'PUBLIC' ELSE pg_get_userbyid(role_oid) END) FROM unnest(p.polroles) role_oid),
      'permissive',p.polpermissive,'using_expression',pg_get_expr(p.polqual,p.polrelid),
      'check_expression',pg_get_expr(p.polwithcheck,p.polrelid)
    )
  FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN target_tables t ON t.schema_name=n.nspname AND t.table_name=c.relname

  UNION ALL
  SELECT 'trigger',n.nspname||'.'||c.relname||'.'||tr.tgname,
    jsonb_build_object(
      'schema',n.nspname,'table',c.relname,'name',tr.tgname,'function',pn.nspname||'.'||pr.proname,
      'definition',pg_get_triggerdef(tr.oid,true)
    )
  FROM pg_trigger tr JOIN pg_class c ON c.oid=tr.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN target_tables t ON t.schema_name=n.nspname AND t.table_name=c.relname
  JOIN pg_proc pr ON pr.oid=tr.tgfoid JOIN pg_namespace pn ON pn.oid=pr.pronamespace
  WHERE NOT tr.tgisinternal

  UNION ALL
  SELECT 'function',n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',
    jsonb_build_object(
      'schema',n.nspname,'name',p.proname,'signature',pg_get_function_identity_arguments(p.oid),
      'return_type',pg_get_function_result(p.oid),'language',l.lanname,
      'volatility',CASE p.provolatile WHEN 'i' THEN 'immutable' WHEN 's' THEN 'stable' ELSE 'volatile' END,
      'security_definer',p.prosecdef,
      'configuration',COALESCE((SELECT jsonb_agg(value ORDER BY value) FROM unnest(p.proconfig) value),'[]'::jsonb),
      'definition',pg_get_functiondef(p.oid)
    )
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
  JOIN target_functions f ON f.schema_name=n.nspname AND f.function_name=p.proname AND f.identity_args=pg_get_function_identity_arguments(p.oid)

  UNION ALL
  SELECT 'table_privilege',n.nspname||'.'||c.relname||'.'||pr.principal,
    jsonb_build_object(
      'schema',n.nspname,'table',c.relname,'principal',pr.principal,
      'principal_name',CASE WHEN pr.principal='owner' THEN pg_get_userbyid(c.relowner) ELSE pr.role_name::text END,
      'explicit_privileges',COALESCE((
        SELECT jsonb_agg(e.privilege_type ORDER BY e.privilege_type)
        FROM aclexplode(c.relacl) e
        WHERE e.grantee=CASE WHEN pr.principal='PUBLIC' THEN 0 WHEN pr.principal='owner' THEN c.relowner ELSE (SELECT oid FROM pg_roles WHERE rolname=pr.role_name) END
      ),'[]'::jsonb),
      'effective_privileges',CASE WHEN pr.principal='PUBLIC' THEN '[]'::jsonb ELSE COALESCE((
        SELECT jsonb_agg(operation ORDER BY operation)
        FROM unnest(ARRAY['DELETE','INSERT','MAINTAIN','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE']) operation
        WHERE has_table_privilege(CASE WHEN pr.principal='owner' THEN pg_get_userbyid(c.relowner) ELSE pr.role_name::text END,c.oid,operation)
      ),'[]'::jsonb) END
    )
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN target_tables t ON t.schema_name=n.nspname AND t.table_name=c.relname CROSS JOIN principals pr

  UNION ALL
  SELECT 'function_privilege',n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||').'||pr.principal,
    jsonb_build_object(
      'schema',n.nspname,'function',p.proname,'signature',pg_get_function_identity_arguments(p.oid),
      'principal',pr.principal,
      'principal_name',CASE WHEN pr.principal='owner' THEN pg_get_userbyid(p.proowner) ELSE pr.role_name::text END,
      'explicit_execute',EXISTS(
        SELECT 1 FROM aclexplode(p.proacl) e
        WHERE e.grantee=CASE WHEN pr.principal='PUBLIC' THEN 0 WHEN pr.principal='owner' THEN p.proowner ELSE (SELECT oid FROM pg_roles WHERE rolname=pr.role_name) END
          AND e.privilege_type='EXECUTE'
      ),
      'effective_execute',CASE WHEN pr.principal='PUBLIC' THEN NULL ELSE has_function_privilege(CASE WHEN pr.principal='owner' THEN pg_get_userbyid(p.proowner) ELSE pr.role_name::text END,p.oid,'EXECUTE') END
    )
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  JOIN target_functions f ON f.schema_name=n.nspname AND f.function_name=p.proname AND f.identity_args=pg_get_function_identity_arguments(p.oid) CROSS JOIN principals pr
)
SELECT jsonb_build_object('category',category,'identity',identity,'data',data)::text
FROM catalog_rows
ORDER BY CASE category
  WHEN 'table' THEN 1 WHEN 'column' THEN 2 WHEN 'constraint' THEN 3 WHEN 'index' THEN 4
  WHEN 'foreign_key' THEN 5 WHEN 'rls' THEN 6 WHEN 'policy' THEN 7 WHEN 'trigger' THEN 8
  WHEN 'function' THEN 9 WHEN 'table_privilege' THEN 10 WHEN 'function_privilege' THEN 11
  ELSE 99 END, identity COLLATE "C";
ROLLBACK;
