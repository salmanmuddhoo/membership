-- The Mauritian National Identity Card carries no expiry date (M4 correction).
set local albarakah.actor_description = 'migration 0015_identity_card_does_not_expire';

-- Seeded as tracking expiry, which made the upload form demand a date that is
-- not printed on the document. An officer with the card in front of them had
-- nothing to type, and the service refused the upload without it.
--
-- Passports and residence permits do expire; if the Society starts accepting
-- those they are separate document types with tracks_expiry set on them.
update document_type
   set tracks_expiry = false
 where code = 'id_card';

-- Anything already filed against it carries a date that no longer means
-- anything, and the expiry job would still act on it. Cleared, so the job has
-- nothing to find.
update document d
   set expires_at = null
  from document_type t
 where t.id = d.document_type_id
   and t.code = 'id_card'
   and d.expires_at is not null;
