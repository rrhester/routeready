-- 0357_seasonal_driver_status.sql
-- Adds a "seasonal" value to the driver_status enum so drivers can be
-- tracked as seasonal employees (a distinct bucket, not rolled into
-- active). Idempotent: ADD VALUE IF NOT EXISTS is a no-op if it already
-- exists, so re-running this migration is safe.
alter type public.driver_status add value if not exists 'seasonal';
