-- Bug fix (epics.md amendment to Story 5.2): a typical per-message AI cost
-- is a fraction of a cent (e.g. $0.00035 for a ~1,400-token turn on
-- gpt-6-luna), which this column's previous minor-unit (cent) granularity
-- rounded straight to zero. Renamed in place rather than dropped/recreated
-- — no existing rows reference this column's old meaning (confirmed: zero
-- rows in `message_costs` before this story's first real usage), so a
-- rename is safe and loses nothing. Same integer type throughout: still
-- never a float (AD-27) — only the unit scale changes, from minor units
-- (cents) to micro-units (millionths of the currency unit).
ALTER TABLE "message_costs" RENAME COLUMN "amount_minor_units_usd" TO "amount_micro_units_usd";
