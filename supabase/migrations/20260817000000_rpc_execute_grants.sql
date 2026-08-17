-- Phase 7 pre-deploy hardening: Growup RPCs are server-only.
-- The app calls these functions through the server-side Supabase service role.
-- No browser client should be able to execute subscription, payment, promo, or platform-admin RPCs directly.

revoke execute on function public.growup_activate_zero_amount_subscription_payment(uuid, text, text) from public, anon, authenticated;
grant execute on function public.growup_activate_zero_amount_subscription_payment(uuid, text, text) to service_role;

revoke execute on function public.growup_begin_subscription_payment(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.growup_begin_subscription_payment(uuid, text, text, text) to service_role;

revoke execute on function public.growup_normalize_promotion_code(text) from public, anon, authenticated;
grant execute on function public.growup_normalize_promotion_code(text) to service_role;

revoke execute on function public.growup_payment_period_end(timestamptz, text) from public, anon, authenticated;
grant execute on function public.growup_payment_period_end(timestamptz, text) to service_role;

revoke execute on function public.growup_platform_admin_overview(text) from public, anon, authenticated;
grant execute on function public.growup_platform_admin_overview(text) to service_role;

revoke execute on function public.growup_platform_admin_payments(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.growup_platform_admin_payments(text, text, integer, integer) to service_role;

revoke execute on function public.growup_platform_admin_promotion_codes(text) from public, anon, authenticated;
grant execute on function public.growup_platform_admin_promotion_codes(text) to service_role;

revoke execute on function public.growup_platform_admin_role(text) from public, anon, authenticated;
grant execute on function public.growup_platform_admin_role(text) to service_role;

revoke execute on function public.growup_platform_admin_tenant_detail(text, uuid) from public, anon, authenticated;
grant execute on function public.growup_platform_admin_tenant_detail(text, uuid) to service_role;

revoke execute on function public.growup_platform_admin_tenants(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.growup_platform_admin_tenants(text, text, integer, integer) to service_role;

revoke execute on function public.growup_platform_admin_upsert_promotion_code(text, jsonb) from public, anon, authenticated;
grant execute on function public.growup_platform_admin_upsert_promotion_code(text, jsonb) to service_role;

revoke execute on function public.growup_promotion_benefit_description(text, numeric) from public, anon, authenticated;
grant execute on function public.growup_promotion_benefit_description(text, numeric) to service_role;

revoke execute on function public.growup_record_provider_payment_status(text, text, uuid, text, integer, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.growup_record_provider_payment_status(text, text, uuid, text, integer, text, text, jsonb) to service_role;

revoke execute on function public.growup_record_provider_payment_success(text, text, uuid, text, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.growup_record_provider_payment_success(text, text, uuid, text, integer, text, jsonb) to service_role;

revoke execute on function public.growup_require_platform_admin(text) from public, anon, authenticated;
grant execute on function public.growup_require_platform_admin(text) to service_role;

revoke execute on function public.growup_set_payment_provider_reference(uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.growup_set_payment_provider_reference(uuid, uuid, text, text, text, jsonb) to service_role;

revoke execute on function public.growup_signup_bootstrap(text, text, text, text, text, text, jsonb, text, text, text) from public, anon, authenticated;
grant execute on function public.growup_signup_bootstrap(text, text, text, text, text, text, jsonb, text, text, text) to service_role;

revoke execute on function public.growup_subscription_base_amount_minor(text, text) from public, anon, authenticated;
grant execute on function public.growup_subscription_base_amount_minor(text, text) to service_role;

revoke execute on function public.growup_validate_promotion_code(text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.growup_validate_promotion_code(text, text, text, uuid) to service_role;
