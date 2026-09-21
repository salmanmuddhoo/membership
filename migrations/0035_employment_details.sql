-- Officer feedback: an Individual applicant's employment should be captured
-- alongside their other particulars — a member or a non-member opening an
-- account of their own (S-614) capture against this same "individual" type
-- and its field configuration, so this reaches both without a second set of
-- fields. Not Corporate (a registered entity has no employment of its own)
-- or Minor (a dependant, by definition).
--
-- Optional by default (is_mandatory false, the column's own default) —
-- Configuration -> Membership types can turn any of these mandatory or hide
-- them, the same as every other field here, without a release.
set local albarakah.actor_description = 'migration 0035_employment_details';

alter table membership_type_field drop constraint membership_type_field_subject_check;
alter table membership_type_field add constraint membership_type_field_subject_check
    check (subject in ('applicant', 'nominee', 'guardian', 'beneficiary', 'employment'));

alter table application_party drop constraint application_party_subject_check;
alter table application_party add constraint application_party_subject_check
    check (subject in ('applicant', 'nominee', 'guardian', 'beneficiary', 'employment'));

insert into membership_type_field
    (membership_type_id, field_key, label, data_type, choices, subject,
     is_mandatory, sort_order)
select m.id, f.field_key, f.label, f.data_type, f.choices::jsonb, f.subject,
       f.is_mandatory, f.sort_order
  from (values
    ('individual', 'employer_name',      'Employer name',      'text',   '[]', 'employment', false, 1),
    ('individual', 'occupation',         'Occupation',         'text',   '[]', 'employment', false, 2),
    ('individual', 'employment_status',  'Employment status',  'choice',
     '["Employed","Self-employed","Unemployed","Retired","Student"]',    'employment', false, 3),
    ('individual', 'monthly_income',     'Monthly income',     'number', '[]', 'employment', false, 4)
  ) as f(type_code, field_key, label, data_type, choices, subject, is_mandatory, sort_order)
  join membership_type m on m.code = f.type_code;
