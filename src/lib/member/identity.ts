// Who a member app session is, and how it comes to exist (docs/member-app.md).
//
// Four things, kept apart on purpose:
//
//   identification  NIC + AB Number name exactly one active member
//                   (linkMember). Opens nothing by itself.
//   verification    a one-time code proves the person holds the mobile on
//                   that member's record (verifyOtp)
//   authentication  the session that results — an access token the device
//                   presents on every request, and a refresh token that
//                   renews it (resolveMemberSession, refreshSession)
//   the link        member_session.member_id, resolved here on every
//                   request and never sent to the phone
//
// A new applicant has no AB Number and gets an applicant session from a
// verified mobile alone (startSignUp). That session never resolves to a
// member record, whoever the number belongs to — which is what lets sign-up
// answer everyone the same way without revealing who is a member.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { recordAudit, recordAuditQuietly } from '../access/audit';
import { ApiError } from '../api/envelope';
import { checkRateLimit } from '../api/rate-limit';
import { PhoneFormatError, toInternational } from '../applications/phone';
import { getMemberConfig, type MemberConfig } from '../config';
import { query, withTransaction } from '../db/pool';
import {
  CODE_TTL_SECONDS,
  codeDelivery,
  codeMatches,
  codeMessage,
  generateCode,
  hashCode,
  MAX_ATTEMPTS,
  maskMobile,
  type CodeDelivery,
} from './otp';

export type IdentityKind = 'member' | 'customer' | 'applicant';

// A resolved member app session. The counterpart of the staff Principal
// (access/principal.ts), and deliberately nothing like it: no permissions,
// no roles — one identity, and the record it is linked to.
export interface MemberPrincipal {
  sessionId: string;
  // E.164, verified.
  mobile: string;
  memberId: string | null;
  customerId: string | null;
  kind: IdentityKind;
}

export interface OtpChallenge {
  challengeId: string;
  purpose: 'link_member' | 'sign_up';
  // Masked, for a sign-up: the number the person just typed. Null for a
  // link: saying even a masked number would confirm the NIC + AB Number
  // pair named someone, and the person is told it went to the mobile on
  // their record.
  sentTo: string | null;
  expiresInSeconds: number;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  identity: {
    kind: IdentityKind;
    memberNo: string | null;
    displayName: string;
    mobile: string;
    linkedAt: string;
  };
}

// Where a request came from, for rate limits and the audit trail. The
// address is attacker-supplied and only ever used to slow one down.
export interface RequestOrigin {
  ip: string | null;
  correlationId: string;
  deviceLabel?: string | null;
}

const AUDIENCE = 'member-app';
const ACTOR = 'member-app';

// --- Identification -------------------------------------------------------

// The NIC as it is written on the card and captured on the form: letters and
// digits, no spaces. Compared case-insensitively against the applicant
// party, which is where a member's NIC lives (capture.ts's own
// searchExistingMembers joins the same way).
export function normaliseNic(raw: string): string | null {
  const nic = raw.trim().toUpperCase().replace(/\s+/g, '');
  return /^[A-Z0-9]{6,20}$/.test(nic) ? nic : null;
}

// AB0001, as printed on the card (member.member_no). Also what the business
// calls the Shares Account Number.
export function normaliseAbNumber(raw: string): string | null {
  const ab = raw.trim().toUpperCase().replace(/\s+/g, '');
  return /^[A-Z]{1,4}\d{1,10}$/.test(ab) ? ab : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// How many times a challenge may be asked for. Counted whether or not the
// pair matched: the endpoint an attacker with a stolen card would hit is
// this one, and a miss must cost the same as a hit.
const LINK_LIMIT = { max: 5, windowSeconds: 60 * 60 };
const LINK_IP_LIMIT = { max: 20, windowSeconds: 60 * 60 };
const SIGN_UP_LIMIT = { max: 3, windowSeconds: 10 * 60 };
const SIGN_UP_IP_LIMIT = { max: 20, windowSeconds: 60 * 60 };

async function enforce(
  subject: string,
  correlationId: string,
  limit: { max: number; windowSeconds: number }
): Promise<void> {
  const result = await checkRateLimit(subject, correlationId, limit);
  if (!result.allowed) {
    throw new ApiError(
      'rate_limited',
      'Too many attempts. Please wait before trying again.'
    );
  }
}

// A second code for the same key within this window is refused, whoever
// asks: the app shows a countdown of the same length before offering
// Resend. Read from the challenge rows themselves rather than the rate
// limiter, so it holds even where the limiter is switched off.
export const RESEND_COOLDOWN_SECONDS = 30;

async function assertCooldown(requestKey: string): Promise<void> {
  const last = await query<{ wait: number }>(
    `select ceil(extract(epoch from
              (created_at + make_interval(secs => $2) - now())))::int as wait
       from member_login_challenge
      where request_key = $1
      order by created_at desc
      limit 1`,
    [requestKey, RESEND_COOLDOWN_SECONDS]
  );
  const wait = last.rows[0]?.wait ?? 0;
  if (wait > 0) {
    throw new ApiError(
      'rate_limited',
      `Wait ${wait} second${wait === 1 ? '' : 's'} before requesting another code.`
    );
  }
}

interface ChallengeInput {
  purpose: 'link_member' | 'link_member_miss' | 'sign_up';
  requestKey: string;
  // Empty for a miss: there is nobody to send to.
  mobile: string;
  memberId: string | null;
}

// A row, a code, and — unless this is a miss — an SMS. A miss gets the
// same row with a random hash nothing can match, no message, and the same
// answer, so the caller cannot tell the two apart.
async function issueChallenge(
  input: ChallengeInput,
  delivery: CodeDelivery,
  config: MemberConfig
): Promise<OtpChallenge> {
  const miss = input.purpose === 'link_member_miss';
  const code = miss ? randomBytes(8).toString('hex') : generateCode(config);
  const inserted = await query<{ id: string }>(
    `insert into member_login_challenge
       (purpose, request_key, mobile, member_id, code_hash, expires_at)
     values ($1, $2, $3, $4, 'pending', now() + make_interval(secs => $5))
     returning id`,
    [
      input.purpose,
      input.requestKey,
      input.mobile,
      input.memberId,
      CODE_TTL_SECONDS,
    ]
  );
  const challengeId = inserted.rows[0].id;
  // The hash salts on the row's own id, which did not exist until the insert.
  await query(
    `update member_login_challenge set code_hash = $2 where id = $1`,
    [challengeId, hashCode(challengeId, code)]
  );

  // Sent after the row exists, so a code that arrives always has a
  // challenge to verify against; a send that fails takes the challenge with
  // it, so a code that never arrived cannot be guessed at later.
  if (!miss) {
    try {
      await delivery.send(input.mobile, codeMessage(code));
    } catch (error) {
      await query(
        `update member_login_challenge set consumed_at = now() where id = $1`,
        [challengeId]
      );
      throw error;
    }
  }

  return {
    challengeId,
    purpose: input.purpose === 'sign_up' ? 'sign_up' : 'link_member',
    sentTo: input.purpose === 'sign_up' ? maskMobile(input.mobile) : null,
    expiresInSeconds: CODE_TTL_SECONDS,
  };
}

/**
 * Identify an existing member by NIC + AB Number and send a code to the
 * mobile on their record.
 *
 * The answer is the same whether the pair named someone or not: a
 * challenge id, no number. A miss gets a challenge nothing can verify
 * against; a hit gets a code on the registered mobile. "No such NIC", "no
 * such AB Number", "not together" and "not active" are indistinguishable
 * from outside — the difference is in the audit trail. Rate-limited per
 * NIC, per AB Number and per address before the lookup, and one code per
 * AB Number per cooldown window, so a miss costs exactly what a hit does.
 */
export async function linkMember(
  input: { nic: string; abNumber: string },
  origin: RequestOrigin,
  options: { delivery?: CodeDelivery; config?: MemberConfig } = {}
): Promise<OtpChallenge> {
  const config = options.config ?? getMemberConfig();
  const delivery = options.delivery ?? codeDelivery(config);

  const details: Record<string, string[]> = {};
  const nic = normaliseNic(input.nic ?? '');
  const abNumber = normaliseAbNumber(input.abNumber ?? '');
  if (!nic) details.nic = ['Enter the NIC exactly as it appears on the card.'];
  if (!abNumber) {
    details.abNumber = ['Enter the AB Number as on your card, e.g. AB0001.'];
  }
  if (!nic || !abNumber) {
    throw new ApiError('validation_failed', 'Check the details.', details);
  }

  await enforce(
    `member-link:nic:${sha256(nic)}`,
    origin.correlationId,
    LINK_LIMIT
  );
  await enforce(`member-link:ab:${abNumber}`, origin.correlationId, LINK_LIMIT);
  if (origin.ip) {
    await enforce(
      `member-link:ip:${origin.ip}`,
      origin.correlationId,
      LINK_IP_LIMIT
    );
  }
  // One code per AB Number per window, hit or miss alike.
  await assertCooldown(`link:${abNumber}`);

  // Exact pair, active only. NIC is not a column on member: it lives on the
  // applicant party of the application that created them, joined the same
  // way the officer's own member search does — but matched whole, never as
  // a fragment, and never returning a name.
  const found = await query<{ id: string; mobile: string | null }>(
    `select m.id, p.values->>'mobile' as mobile
       from member m
       join membership_application a on a.id = m.application_id
       join application_party p
         on p.application_id = a.id and p.subject = 'applicant' and p.ordinal = 1
      where m.status = 'active'
        and upper(m.member_no) = $1
        and upper(regexp_replace(coalesce(p.values->>'nic', ''), '\\s', '', 'g')) = $2
      limit 1`,
    [abNumber, nic]
  );

  const member = found.rows[0];
  if (!member || !member.mobile) {
    // Recorded in full here — the NIC hashed, the AB Number as typed — and
    // nowhere the caller can see.
    await recordAuditQuietly({
      actorDescription: ACTOR,
      action: 'member.link.refused',
      entityType: 'member_login_challenge',
      entityId: abNumber,
      newValue: {
        reason: member ? 'no_mobile_on_record' : 'no_match',
        nicHash: sha256(nic).slice(0, 16),
      },
      requestId: origin.correlationId,
      ipAddress: origin.ip,
    });
    return issueChallenge(
      {
        purpose: 'link_member_miss',
        requestKey: `link:${abNumber}`,
        mobile: '',
        memberId: null,
      },
      delivery,
      config
    );
  }

  const challenge = await issueChallenge(
    {
      purpose: 'link_member',
      requestKey: `link:${abNumber}`,
      mobile: member.mobile,
      memberId: member.id,
    },
    delivery,
    config
  );

  await recordAuditQuietly({
    actorDescription: ACTOR,
    action: 'member.link.requested',
    entityType: 'member',
    entityId: member.id,
    newValue: {
      challengeId: challenge.challengeId,
      sentTo: maskMobile(member.mobile),
    },
    requestId: origin.correlationId,
    ipAddress: origin.ip,
  });

  return challenge;
}

/**
 * Verify a mobile number to start a membership application. No AB Number
 * needed, and always the same answer for a well-formed number — the session
 * this leads to is an applicant's whoever the number belongs to.
 */
export async function startSignUp(
  input: { mobile: string },
  origin: RequestOrigin,
  options: { delivery?: CodeDelivery; config?: MemberConfig } = {}
): Promise<OtpChallenge> {
  const config = options.config ?? getMemberConfig();
  const delivery = options.delivery ?? codeDelivery(config);

  let mobile: string;
  try {
    mobile = toInternational(input.mobile ?? '');
  } catch (error) {
    throw new ApiError('validation_failed', 'Check the mobile number.', {
      mobile: [
        error instanceof PhoneFormatError ? error.message : 'Check the number.',
      ],
    });
  }

  await enforce(
    `member-signup:mobile:${mobile}`,
    origin.correlationId,
    SIGN_UP_LIMIT
  );
  if (origin.ip) {
    await enforce(
      `member-signup:ip:${origin.ip}`,
      origin.correlationId,
      SIGN_UP_IP_LIMIT
    );
  }
  await assertCooldown(`signup:${mobile}`);

  const challenge = await issueChallenge(
    {
      purpose: 'sign_up',
      requestKey: `signup:${mobile}`,
      mobile,
      memberId: null,
    },
    delivery,
    config
  );
  await recordAuditQuietly({
    actorDescription: ACTOR,
    action: 'member.signup.requested',
    entityType: 'member_login_challenge',
    entityId: challenge.challengeId,
    newValue: { mobile: maskMobile(mobile) },
    requestId: origin.correlationId,
    ipAddress: origin.ip,
  });
  return challenge;
}

/** A fresh code for a challenge already issued; the old one is dead. */
export async function resendOtp(
  challengeId: string,
  origin: RequestOrigin,
  options: { delivery?: CodeDelivery; config?: MemberConfig } = {}
): Promise<OtpChallenge> {
  const config = options.config ?? getMemberConfig();
  const delivery = options.delivery ?? codeDelivery(config);

  const previous = await query<{
    id: string;
    purpose: ChallengeInput['purpose'];
    request_key: string;
    mobile: string;
    member_id: string | null;
  }>(
    `select id, purpose, request_key, mobile, member_id
       from member_login_challenge
      where id = $1::uuid
        and created_at > now() - interval '30 minutes'`,
    [isUuid(challengeId) ? challengeId : '00000000-0000-0000-0000-000000000000']
  );
  const row = previous.rows[0];
  if (!row) throw new ApiError('not_found', 'Start again.');

  // Before the old one is killed: a refused resend must leave the current
  // code usable.
  await assertCooldown(row.request_key);
  if (row.mobile) {
    await enforce(
      `member-resend:mobile:${row.mobile}`,
      origin.correlationId,
      SIGN_UP_LIMIT
    );
  }
  await query(
    `update member_login_challenge
        set consumed_at = coalesce(consumed_at, now())
      where id = $1`,
    [row.id]
  );

  const next = await issueChallenge(
    {
      purpose: row.purpose,
      requestKey: row.request_key,
      mobile: row.mobile,
      memberId: row.member_id,
    },
    delivery,
    config
  );
  await recordAuditQuietly({
    actorDescription: ACTOR,
    action: 'member.otp.resent',
    entityType: 'member_login_challenge',
    entityId: next.challengeId,
    newValue: { previousChallengeId: row.id, purpose: row.purpose },
    requestId: origin.correlationId,
    ipAddress: origin.ip,
  });
  return next;
}

// --- Verification, and the session it produces ---------------------------

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value
  );
}

function newRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

function signingKey(config: MemberConfig): Uint8Array {
  return new TextEncoder().encode(config.sessionSecret);
}

async function accessTokenFor(
  sessionId: string,
  config: MemberConfig
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sessionId)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${config.accessTokenSeconds}s`)
    .sign(signingKey(config));
}

interface SessionRow {
  id: string;
  mobile: string;
  member_id: string | null;
  customer_id: string | null;
  linked_at: Date;
}

function kindOf(row: { member_id: string | null; customer_id: string | null }) {
  return row.member_id ? 'member' : row.customer_id ? 'customer' : 'applicant';
}

// The name and number the app greets the person by. Read from the record,
// never stored on the session, so a member whose name is corrected sees it
// on their next sign-in.
async function identityFor(row: SessionRow): Promise<Session['identity']> {
  if (row.member_id) {
    const member = await query<{ member_no: string; name: string }>(
      `select m.member_no,
              trim(coalesce(p.values->>'name', '') || ' ' || coalesce(p.values->>'surname', ''))
                as name
         from member m
         left join application_party p
           on p.application_id = m.application_id
          and p.subject = 'applicant' and p.ordinal = 1
        where m.id = $1`,
      [row.member_id]
    );
    const m = member.rows[0];
    return {
      kind: 'member',
      memberNo: m?.member_no ?? null,
      displayName: m?.name || 'Member',
      mobile: row.mobile,
      linkedAt: row.linked_at.toISOString(),
    };
  }
  return {
    kind: kindOf(row),
    memberNo: null,
    displayName: row.customer_id ? 'Customer' : 'Applicant',
    mobile: row.mobile,
    linkedAt: row.linked_at.toISOString(),
  };
}

async function sessionResponse(
  row: SessionRow,
  refreshToken: string,
  config: MemberConfig
): Promise<Session> {
  return {
    accessToken: await accessTokenFor(row.id, config),
    refreshToken,
    expiresInSeconds: config.accessTokenSeconds,
    identity: await identityFor(row),
  };
}

/**
 * Verify the code. For a link_member challenge this is the moment the phone
 * is linked to the member; for sign_up, an applicant session.
 *
 * Five wrong codes burn the challenge. Counted inside the row lock, so two
 * guesses racing cannot both read four.
 */
export async function verifyOtp(
  input: { challengeId: string; code: string },
  origin: RequestOrigin,
  options: { config?: MemberConfig } = {}
): Promise<Session> {
  const config = options.config ?? getMemberConfig();
  const code = (input.code ?? '').trim();
  const challengeId = input.challengeId ?? '';

  if (!isUuid(challengeId)) {
    throw new ApiError(
      'not_found',
      'That code has expired. Request a new one.'
    );
  }
  if (!/^\d{6}$/.test(code)) {
    throw new ApiError('validation_failed', 'That code is not right.', {
      code: ['Enter the 6-digit code that was sent to you.'],
    });
  }

  const refresh = newRefreshToken();

  const row = await withTransaction(async client => {
    const locked = await client.query<{
      id: string;
      purpose: ChallengeInput['purpose'];
      mobile: string;
      member_id: string | null;
      code_hash: string;
      attempts: number;
      live: boolean;
    }>(
      `select id, purpose, mobile, member_id, code_hash, attempts,
              (consumed_at is null and expires_at > now()) as live
         from member_login_challenge
        where id = $1
          for update`,
      [challengeId]
    );
    const challenge = locked.rows[0];
    if (!challenge || !challenge.live) {
      throw new ExpiredChallenge();
    }

    // A miss can never match — its hash is of a value nothing could have
    // sent — but it is checked all the same, so the two take the same path.
    const matches = codeMatches(challenge.id, code, challenge.code_hash);
    if (challenge.purpose === 'link_member_miss' || !matches) {
      // Recorded outside this transaction (see the catch below): a throw
      // rolls everything back, and the count is the control.
      throw new WrongCode();
    }

    await client.query(
      `update member_login_challenge set consumed_at = now() where id = $1`,
      [challenge.id]
    );

    if (challenge.purpose === 'link_member') {
      const member = await client.query<{ status: string }>(
        `select status from member where id = $1`,
        [challenge.member_id]
      );
      if (member.rows[0]?.status !== 'active') {
        throw new ApiError(
          'not_found',
          'That member record is no longer active. Visit a branch.'
        );
      }
    }

    const session = await client.query<SessionRow>(
      `insert into member_session
         (mobile, member_id, refresh_token_hash, expires_at, device_label)
       values ($1, $2, $3, now() + make_interval(days => $4), $5)
       returning id, mobile, member_id, customer_id, linked_at`,
      [
        challenge.mobile,
        challenge.purpose === 'link_member' ? challenge.member_id : null,
        refresh.hash,
        config.refreshTokenDays,
        origin.deviceLabel ?? null,
      ]
    );
    const created = session.rows[0];

    await recordAudit(
      {
        actorDescription: ACTOR,
        action:
          challenge.purpose === 'link_member'
            ? 'member.link.completed'
            : 'member.signup.verified',
        entityType:
          challenge.purpose === 'link_member' ? 'member' : 'member_session',
        entityId:
          challenge.purpose === 'link_member'
            ? challenge.member_id!
            : created.id,
        newValue: {
          sessionId: created.id,
          mobile: maskMobile(challenge.mobile),
          deviceLabel: origin.deviceLabel ?? null,
        },
        requestId: origin.correlationId,
        ipAddress: origin.ip,
      },
      client
    );

    return created;
  }).catch(async error => {
    if (error instanceof ExpiredChallenge) {
      await recordAuditQuietly({
        actorDescription: ACTOR,
        action: 'member.otp.rejected',
        entityType: 'member_login_challenge',
        entityId: challengeId,
        newValue: { reason: 'expired_or_unknown' },
        requestId: origin.correlationId,
        ipAddress: origin.ip,
      });
      throw new ApiError(
        'not_found',
        'That code has expired. Request a new one.'
      );
    }
    if (error instanceof WrongCode) {
      // One statement, so two guesses racing cannot both read four.
      const counted = await query<{ attempts: number }>(
        `update member_login_challenge
            set attempts = attempts + 1,
                consumed_at = case when attempts + 1 >= $2 then now()
                                   else consumed_at end
          where id = $1
          returning attempts`,
        [challengeId, MAX_ATTEMPTS]
      );
      const attempts = counted.rows[0]?.attempts ?? MAX_ATTEMPTS;
      const burnt = attempts >= MAX_ATTEMPTS;
      await recordAuditQuietly({
        actorDescription: ACTOR,
        action: burnt ? 'member.otp.burnt' : 'member.otp.rejected',
        entityType: 'member_login_challenge',
        entityId: challengeId,
        newValue: { attempts, maxAttempts: MAX_ATTEMPTS },
        requestId: origin.correlationId,
        ipAddress: origin.ip,
      });
      if (burnt) {
        throw new ApiError('not_found', 'Too many wrong codes. Start again.');
      }
      throw new ApiError('validation_failed', 'That code is not right.', {
        code: ['Enter the 6-digit code that was sent to you.'],
      });
    }
    throw error;
  });

  return sessionResponse(row, refresh.token, config);
}

class WrongCode extends Error {
  constructor() {
    super('wrong code');
  }
}

class ExpiredChallenge extends Error {
  constructor() {
    super('expired challenge');
  }
}

/** New pair; the old refresh token is dead the moment it is used. */
export async function refreshSession(
  refreshToken: string,
  origin: RequestOrigin,
  options: { config?: MemberConfig } = {}
): Promise<Session> {
  const config = options.config ?? getMemberConfig();
  if (!refreshToken || refreshToken.length > 200) {
    throw new ApiError('unauthenticated', 'Sign in again.');
  }
  const next = newRefreshToken();

  const row = await withTransaction(async client => {
    const live = await client.query<
      SessionRow & { member_status: string | null }
    >(
      `select s.id, s.mobile, s.member_id, s.customer_id, s.linked_at,
              m.status as member_status
         from member_session s
         left join member m on m.id = s.member_id
        where s.refresh_token_hash = $1
          and s.revoked_at is null
          and s.expires_at > now()
        for update of s`,
      [sha256(refreshToken)]
    );
    const found = live.rows[0];
    if (!found) return null;

    // A member who has since left is signed out at the next refresh, not
    // whenever a 90-day token happens to lapse.
    if (found.member_id && found.member_status !== 'active') {
      await client.query(
        `update member_session set revoked_at = now() where id = $1`,
        [found.id]
      );
      return null;
    }

    await client.query(
      `update member_session
          set refresh_token_hash = $2,
              last_used_at = now(),
              expires_at = now() + make_interval(days => $3)
        where id = $1`,
      [found.id, next.hash, config.refreshTokenDays]
    );
    return found;
  });
  if (!row) throw new ApiError('unauthenticated', 'Sign in again.');

  void origin;
  return sessionResponse(row, next.token, config);
}

/** Revoke the session. The device must link again to get back in. */
export async function revokeSession(
  principal: MemberPrincipal,
  origin: RequestOrigin
): Promise<void> {
  await query(
    `update member_session set revoked_at = now()
      where id = $1 and revoked_at is null`,
    [principal.sessionId]
  );
  await recordAuditQuietly({
    actorDescription: ACTOR,
    action: 'member.session.revoked',
    entityType: 'member_session',
    entityId: principal.sessionId,
    newValue: { by: 'logout' },
    requestId: origin.correlationId,
    ipAddress: origin.ip,
  });
}

// --- Authentication, on every request -------------------------------------

// How stale last_used_at may be before a request refreshes it. A write per
// request would be the most expensive thing most requests do.
const TOUCH_AFTER_MS = 15 * 60 * 1000;

/**
 * The bearer token to the session it names, or null. The token is verified
 * locally; the session row is then read, so a revoked session is refused on
 * its very next request rather than when the token happens to expire.
 */
export async function resolveMemberSession(
  authorization: string | null,
  options: { config?: MemberConfig } = {}
): Promise<MemberPrincipal | null> {
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) return null;
  const config = options.config ?? getMemberConfig();

  let sessionId: string;
  try {
    const { payload } = await jwtVerify(match[1], signingKey(config), {
      audience: AUDIENCE,
    });
    if (!payload.sub || !isUuid(payload.sub)) return null;
    sessionId = payload.sub;
  } catch {
    return null;
  }

  const result = await query<{
    id: string;
    mobile: string;
    member_id: string | null;
    customer_id: string | null;
    stale: boolean;
  }>(
    `select id, mobile, member_id, customer_id,
            (last_used_at < now() - make_interval(secs => $2)) as stale
       from member_session
      where id = $1 and revoked_at is null and expires_at > now()`,
    [sessionId, TOUCH_AFTER_MS / 1000]
  );
  const row = result.rows[0];
  if (!row) return null;

  if (row.stale) {
    query(`update member_session set last_used_at = now() where id = $1`, [
      row.id,
    ]).catch(error => console.warn('[member] could not touch session:', error));
  }

  return {
    sessionId: row.id,
    mobile: row.mobile,
    memberId: row.member_id,
    customerId: row.customer_id,
    kind: kindOf(row),
  };
}

// For tests and the audit trail: never compare tokens with ===.
export function tokensEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
