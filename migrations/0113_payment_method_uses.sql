-- A payment method is offered per kind of transaction (officer request).
--
-- Until now an active method was offered on every form: a cheque could be
-- named on a withdrawal although the Society never pays one out that way.
-- Five flags say where a method is offered — money in (a deposit, an
-- application fee), a withdrawal (and a refund), and the three payouts the
-- Treasurer disburses. Every method keeps today's reach, so nothing an
-- officer can choose changes until an administrator unticks a box at
-- Configuration -> Payment methods. The system's own marks (migration,
-- internal_transfer) are never offered, flags or not.
set local albarakah.actor_description = 'migration 0113_payment_method_uses';

alter table payment_method
    add column for_deposit     boolean not null default true,
    add column for_withdrawal  boolean not null default true,
    add column for_closure     boolean not null default true,
    add column for_resignation boolean not null default true,
    add column for_demise      boolean not null default true;

comment on column payment_method.for_deposit is
    'Offered when money comes in: a deposit, an application fee.';
comment on column payment_method.for_withdrawal is
    'Offered when a withdrawal is paid out, or a fee refunded.';
comment on column payment_method.for_closure is
    'Offered when an account closure is disbursed.';
comment on column payment_method.for_resignation is
    'Offered when a resignation is disbursed.';
comment on column payment_method.for_demise is
    'Offered when a demised claim is disbursed.';
