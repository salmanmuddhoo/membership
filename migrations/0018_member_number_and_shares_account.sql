-- A member is one number and two accounts (business correction, Aug 2026).
--
-- What was built assumed a member holds a single account with a number of its
-- own. The Society works differently, and the register it already keeps proves
-- it: a member is AB0001, and that same AB0001 is both their Shares account and
-- their MSA. One number, one person, two accounts.
--
-- Three consequences, in order below: the member number changes format, the
-- account stops carrying a number of its own, and the Shares account type comes
-- into existence.
set local albarakah.actor_description = 'migration 0018_member_number_and_shares_account';

-- ---------------------------------------------------------------------------
-- The member's number
-- ---------------------------------------------------------------------------
-- ABM-000001 was invented here; AB0001 is what the Society uses. Four digits
-- because that is the width of the existing register — lpad does not truncate,
-- so AB10000 follows AB9999 without another migration.
--
-- Renumbering is safe only because no member exists yet. Once one does, this
-- number is on their card, in the legacy register, and in the SharePoint folder
-- name that holds their documents (memberFolderPath), so changing the format
-- again would orphan all three. M7's import must advance member_number_seq past
-- whatever the register already contains (FRD 7.5).
create or replace function next_member_number()
returns text
language sql
volatile
as $$
    select 'AB' || lpad(nextval('member_number_seq')::text, 4, '0');
$$;

-- ---------------------------------------------------------------------------
-- The accounts
-- ---------------------------------------------------------------------------
-- account_no is dropped rather than filled with the member's number. Storing
-- it twice invites the two copies to disagree, and there is no question which
-- would be right: the member's number is the number. Readers join to member,
-- which they already do.
alter table account drop column account_no;

drop function if exists next_account_number();
drop sequence if exists account_number_seq;

-- What "one account per member" becomes now that there are two. The old
-- partial index allowed a single automatically-opened account per member; the
-- rule that matters is that a member holds at most one of each type, which is
-- what stops a retry opening a second Shares account (S-309).
drop index account_one_default_per_member_idx;
create unique index account_one_per_type_per_member_idx
    on account (member_id, account_type_id);

comment on column account.is_membership_default is
    'Opened automatically when the membership was approved. True on more than '
    'one account per member: a membership opens Shares and MSA together.';

-- Several account types are opened on approval now, so the index that allowed
-- exactly one goes.
drop index account_type_single_default_idx;

-- ---------------------------------------------------------------------------
-- The Shares account
-- ---------------------------------------------------------------------------
-- Contributing to Shares is what makes someone a member; the MSA opens beside
-- it. Both are marked as opened on approval, and both are read at approval
-- time, so switching one off is a configuration change (S-206).
insert into account_type
    (code, name, category, minimum_opening_amount, requires_approval,
     default_status, is_membership_default, sort_order)
values
    ('shares', 'Shares', 'shares', 5000.00, false, 'active', true, 0)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- The joining money
-- ---------------------------------------------------------------------------
-- Shares is mandatory. The MSA deposit is optional and configuration decides
-- whether it is taken, so it moves from required to optional rather than being
-- removed: an optional component can still be charged, and does not count
-- towards the amount an applicant is short (amountDueForApplication).
--
-- A NEW VERSION, never an edit: a receipt records the version it charged, and
-- the versions already issued must keep saying what they said (S-207).
update fee_schedule_version
   set superseded_at = now()
 where superseded_at is null;

insert into fee_schedule_version (schedule_id, version_no)
select s.id, coalesce(max(v.version_no), 0) + 1
  from fee_schedule s
  left join fee_schedule_version v on v.schedule_id = s.id
 group by s.id;

insert into fee_component (version_id, code, amount, requirement, sort_order)
select v.id, c.code, c.amount, c.requirement, c.sort_order
  from (values
    ('individual_membership', 'entrance',    1500.00, 'required',       1),
    ('individual_membership', 'takaful',     2000.00, 'required',       2),
    ('individual_membership', 'shares',      5000.00, 'required',       3),
    ('individual_membership', 'msa_deposit', 5000.00, 'optional',       4),
    ('individual_membership', 'processing',     0.00, 'not_applicable', 5),

    ('corporate_membership',  'entrance',    1500.00, 'required',       1),
    ('corporate_membership',  'takaful',     2000.00, 'required',       2),
    ('corporate_membership',  'shares',      5000.00, 'required',       3),
    ('corporate_membership',  'msa_deposit', 5000.00, 'optional',       4),
    ('corporate_membership',  'processing',     0.00, 'not_applicable', 5),

    ('minor_membership',      'entrance',    1500.00, 'required',       1),
    ('minor_membership',      'takaful',     2000.00, 'required',       2),
    ('minor_membership',      'shares',      5000.00, 'required',       3),
    ('minor_membership',      'msa_deposit', 5000.00, 'optional',       4),
    ('minor_membership',      'processing',     0.00, 'not_applicable', 5)
  ) as c(schedule_code, code, amount, requirement, sort_order)
  join fee_schedule s on s.code = c.schedule_code
  join fee_schedule_version v
    on v.schedule_id = s.id and v.superseded_at is null;
