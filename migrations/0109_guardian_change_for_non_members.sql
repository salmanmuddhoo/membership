-- A non-member minor's guardian can be replaced too (functional round).
--
-- 0107 hung a change of guardian on a Minor member only, so a minor who
-- holds an account without being a member kept a guardian who had died,
-- and money could still leave their accounts. The same change now hangs on
-- either holder: a member or a non-member customer, exactly one of them.
set local albarakah.actor_description = 'migration 0109_guardian_change_for_non_members';

alter table guardian_change
    alter column member_id drop not null,
    add column customer_id uuid references customer(id) on delete cascade,
    add constraint guardian_change_has_one_holder
        check (num_nonnulls(member_id, customer_id) = 1);

-- One change waiting per minor, for a non-member as for a member (0107).
create unique index guardian_change_one_open_customer_idx
    on guardian_change (customer_id)
 where status = 'submitted';
