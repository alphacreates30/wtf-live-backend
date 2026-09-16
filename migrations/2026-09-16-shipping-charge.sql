-- Postage is charged at actual cost, weighed at packing time (not estimated
-- from per-lot weight/dimension columns - that approach is superseded, see
-- wtf-handoff/FULFILMENT_CHOICE_AND_WEIGHTS_BRIEF.md Part 2).
--
-- Nullable, only meaningful for orders with fulfillment_choice = 'shipping'.
-- shipping_payment_status mirrors payment_status's shape (unpaid | charging |
-- paid | failed) but is a plain text column with no DB-level check
-- constraint, same as payment_status - validated in application code only,
-- consistent with the rest of this table.
alter table orders add column if not exists shipping_cost_cents integer;
alter table orders add column if not exists shipping_payment_intent_id text;
alter table orders add column if not exists shipping_payment_status text;
alter table orders add column if not exists shipping_payment_error text;
alter table orders add column if not exists shipping_charging_since timestamptz;
