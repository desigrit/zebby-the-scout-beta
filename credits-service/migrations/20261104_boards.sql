-- Add Boards quotes without changing existing wallets, balances, or analyses.
BEGIN;
ALTER TABLE public.zebby_quotes DROP CONSTRAINT IF EXISTS zebby_quotes_kind_check;
ALTER TABLE public.zebby_quotes ADD CONSTRAINT zebby_quotes_kind_check
  CHECK(kind IN ('plan','match','resume','board_extract'));
COMMIT;
