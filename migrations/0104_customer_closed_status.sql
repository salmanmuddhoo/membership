-- A non-member whose every account has been closed is no longer an active
-- customer (officer feedback: someone whose only HSA was closed still read
-- "Active", with no account at all). From now on the closure that closes
-- their last account marks them 'closed' (markCustomerClosedOnceAllClosed,
-- src/lib/ledger/claimants.ts), and opening a new account for them makes
-- them active again. This corrects everyone already in that state: an
-- active customer who has accounts, none of them still open.
update customer c
   set status = 'closed', updated_at = now()
 where c.status = 'active'
   and exists (select 1 from account a where a.customer_id = c.id)
   and not exists (select 1 from account a
                    where a.customer_id = c.id and a.status <> 'closed');
