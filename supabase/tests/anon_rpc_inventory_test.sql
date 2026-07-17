-- ───────────────────────────────────────────────────────────────────────
-- anon_rpc_inventory_test.sql · project-review PR#53
--
-- Dozens of SECURITY DEFINER functions are deliberately anon-executable
-- (token-keyed public flows: screening, referrals, driver invite codes,
-- coaching links, driver chat/push, booking…). Function hygiene is
-- otherwise excellent (search_path pinned everywhere), but nothing
-- watched the INVENTORY: a future migration granting anon execute on a
-- new definer function would silently widen the anonymous surface.
--
-- This test freezes the current anon-executable definer set. A new name
-- appearing FAILS the migration check until it's consciously added to
-- the allowlist below (i.e. someone reviewed that it's token-gated).
-- Names disappearing is fine (tightening never fails).
-- ───────────────────────────────────────────────────────────────────────

do $$
declare
  v_unexpected text;
begin
  with anon_definers as (
    select p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and has_function_privilege('anon', p.oid, 'execute')
  ),
  allowlist(proname) as (
    -- Frozen at 0504-era, generated from the migrations' actual
    -- "grant execute ... to anon" statements. Every entry is a token-
    -- keyed public flow. Additions require review: is it token-gated?
    select unnest(array[
      'book_interview_slot',
      'booking_confirm',
      'booking_load',
      'booking_preview',
      'booking_running_late',
      'booking_verify_start',
      'cancel_interview_booking',
      'coaching_acknowledge_via_token',
      'coaching_for_driver_token',
      'driver_ack_coaching',
      'driver_ack_message',
      'driver_activate',
      'driver_activation_lookup',
      'driver_assigned_van',
      'driver_assignment_acknowledge',
      'driver_assignments_list',
      'driver_attendance_overview',
      'driver_attendance_settings',
      'driver_channel_mark_read',
      'driver_channel_mentions',
      'driver_channel_message_react',
      'driver_channel_messages',
      'driver_channel_mute',
      'driver_channel_post',
      'driver_channel_reactions',
      'driver_channel_set_mentions',
      'driver_channels_list',
      'driver_chat_delete',
      'driver_chat_edit',
      'driver_chat_list',
      'driver_chat_mark_delivered',
      'driver_chat_mark_read',
      'driver_chat_reactions',
      'driver_chat_send',
      'driver_checkin',
      'driver_checkin_status',
      'driver_checkout',
      'driver_clear_dl_image',
      'driver_device_push_register',
      'driver_envelope_decline',
      'driver_envelope_sign',
      'driver_envelope_view',
      'driver_envelopes_list',
      'driver_get_availability',
      'driver_get_checklist',
      'driver_get_form',
      'driver_get_profile',
      'driver_i9_get',
      'driver_i9_save_section1',
      'driver_i9_submit_section1',
      'driver_list_checklists',
      'driver_list_coachings',
      'driver_list_forms',
      'driver_log_form_event',
      'driver_me',
      'driver_meet_radio_code',
      'driver_message_react',
      'driver_my_schedule',
      'driver_offer_list',
      'driver_offer_respond',
      'driver_onboarding_step_ack',
      'driver_onboarding_steps',
      'driver_open_shift_pickup',
      'driver_open_shifts_list',
      'driver_pending_shift_confirmations',
      'driver_push_register',
      'driver_push_unregister',
      'driver_push_vapid_key',
      'driver_recognition_delivered',
      'driver_recognition_dismiss',
      'driver_recognitions_pending',
      'driver_report_missed_day',
      'driver_report_vehicle_document',
      'driver_request_activation',
      'driver_resolve_van_today',
      'driver_respond_to_shift_confirmation',
      'driver_save_checklist',
      'driver_set_availability',
      'driver_set_dl_image',
      'driver_set_fifth_day_ok',
      'driver_set_photo',
      'driver_set_pin',
      'driver_set_preferred_days',
      'driver_signin_with_phone',
      'driver_signout',
      'driver_submit_availability',
      'driver_submit_checklist',
      'driver_submit_form',
      'driver_swap_list',
      'driver_swap_pool',
      'driver_swap_request',
      'driver_swap_respond',
      'driver_team_roster',
      'driver_time_off_cancel',
      'driver_time_off_list',
      'driver_time_off_request',
      'driver_undo_checkout',
      'driver_update_profile',
      'driver_vehicle_days',
      'driver_vehicle_document_view',
      'intake_applicant',
      'intake_referral',
      'interview_open_slots',
      'meet_ice_servers',
      'meet_lookup',
      'redeem_driver_invite',
      'referrer_lookup',
      'rsvp_respond',
      'screening_load',
      'screening_submit',
      'send_booking_confirmation',
      'session_waitlist_join'
    ])
  )
  select string_agg(a.proname, ', ' order by a.proname)
    into v_unexpected
  from anon_definers a
  where not exists (select 1 from allowlist w where w.proname = a.proname);

  if v_unexpected is not null then
    raise exception 'anon-executable SECURITY DEFINER functions not on the reviewed allowlist: %. If intentional (token-gated public flow), add to supabase/tests/anon_rpc_inventory_test.sql.', v_unexpected;
  end if;
  raise notice 'anon_rpc_inventory: ok';
end $$;
