-- Every transaction list and the transactions report read the ledger the
-- same way: every transaction but the credit leg of a transfer (shown once,
-- as its debit leg), newest first (src/lib/ledger/history.ts,
-- src/lib/reports/definitions.ts). Nothing indexed that shape, so each read
-- scanned the whole table (performance QA: at 80,000 transactions, a
-- sequential scan on every list page, growing with the ledger).
create index if not exists transaction_listed_idx
    on transaction (created_at desc, serial_no desc)
 where leg_direction is distinct from 'credit';
