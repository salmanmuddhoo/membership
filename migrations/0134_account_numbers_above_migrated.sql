-- Number a new account above every number already on file.
--
-- next_customer_account_number (0027) hands out the serial its per-type
-- counter holds. The legacy members import (migration/members.ts,
-- openMigrationAccount) writes each HSA and Investment account with the
-- number it had in the register — HSA0205, INV0012 — and never touches that
-- counter. So the first account opened after an import was numbered HSA0001,
-- which a migrated account already held, and approving its application
-- failed on account_no_unique_idx.
--
-- The counter now moves past the highest serial on file under the type's
-- prefix before it hands one out, so an import (or anything else that
-- writes a number directly) can never leave it behind. The counter row's
-- lock still serialises two approvals of the same type.
--
-- A serial past 9999 is written in full rather than cut to four digits by
-- lpad.
create or replace function next_customer_account_number(p_account_type_id uuid)
returns text
language plpgsql
as $$
declare
    v_prefix text;
    v_floor  integer;
    v_serial integer;
begin
    select upper(btrim(number_prefix)) into v_prefix
      from account_type where id = p_account_type_id;
    if v_prefix is null or v_prefix = '' then
        raise exception
            'account_type % has no number_prefix set — set one in '
            'Configuration before opening a customer account of this type',
            p_account_type_id;
    end if;

    -- The highest serial on file under this prefix, whatever type holds it:
    -- the number has to be unique across every account.
    select coalesce(max(substring(upper(account_no) from length(v_prefix) + 1)::integer), 0) + 1
      into v_floor
      from account
     where account_no is not null
       and left(upper(account_no), length(v_prefix)) = v_prefix
       and substring(account_no from length(v_prefix) + 1) ~ '^[0-9]{1,9}$';

    insert into account_number_counter (account_type_id, next_serial)
    values (p_account_type_id, v_floor + 1)
    on conflict (account_type_id)
        do update set next_serial =
            greatest(account_number_counter.next_serial, v_floor) + 1
    returning next_serial - 1 into v_serial;

    return v_prefix || case
        when length(v_serial::text) >= 4 then v_serial::text
        else lpad(v_serial::text, 4, '0')
    end;
end;
$$;

comment on function next_customer_account_number(uuid) is
    'HSA0001, INV0001, ... — one counter per account type (S-614), moved '
    'past the highest number already on file under the prefix, so accounts '
    'migrated with their legacy numbers are never numbered again. Refuses '
    'a type with no number_prefix configured rather than numbering an '
    'account with nothing on it.';
