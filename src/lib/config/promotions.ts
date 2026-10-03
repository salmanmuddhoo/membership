// What the member app's home screen promotes (migration 0111).
//
// An administrator writes the cards on the Member app configuration page;
// the app reads whichever are live, in order. Writes go through
// withConfigurationActor like every other piece of configuration, so the
// audit trail says who changed which card.
import { query, withConfigurationActor } from '../db/pool';
import { cached } from './cache';
import { ConfigError, type Actor } from './reference';
import type { ConfigurationActor } from '../db/pool';

export interface Promotion {
  id: string;
  title: string;
  body: string;
  imageUrl: string | null;
  linkUrl: string | null;
  linkLabel: string | null;
  accent: string | null;
  isActive: boolean;
  // ISO dates (YYYY-MM-DD), or null for no bound.
  startsOn: string | null;
  endsOn: string | null;
  sortOrder: number;
  // Whether the app would show it right now.
  isLive: boolean;
}

export interface PromotionInput {
  title: string;
  body: string;
  imageUrl: string;
  linkUrl: string;
  linkLabel: string;
  accent: string;
  isActive: boolean;
  startsOn: string;
  endsOn: string;
  sortOrder: string;
}

interface Row {
  id: string;
  title: string;
  body: string;
  image_url: string | null;
  link_url: string | null;
  link_label: string | null;
  accent: string | null;
  is_active: boolean;
  starts_on: string | null;
  ends_on: string | null;
  sort_order: number;
  is_live: boolean;
}

const LIVE_SQL = `(is_active
  and (starts_on is null or starts_on <= current_date)
  and (ends_on is null or ends_on >= current_date))`;

const SELECT = `select id, title, body, image_url, link_url, link_label, accent,
       is_active, to_char(starts_on, 'YYYY-MM-DD') as starts_on,
       to_char(ends_on, 'YYYY-MM-DD') as ends_on, sort_order,
       ${LIVE_SQL} as is_live
  from app_promotion`;

function toPromotion(row: Row): Promotion {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    imageUrl: row.image_url,
    linkUrl: row.link_url,
    linkLabel: row.link_label,
    accent: row.accent,
    isActive: row.is_active,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    sortOrder: row.sort_order,
    isLive: row.is_live,
  };
}

async function readPromotions(): Promise<Promotion[]> {
  const result = await query<Row>(`${SELECT} order by sort_order, created_at`);
  return result.rows.map(toPromotion);
}

// Every card, for the administrator.
export function listPromotions(): Promise<Promotion[]> {
  return cached('app-promotions', readPromotions);
}

// What the app shows now.
export async function livePromotions(): Promise<Promotion[]> {
  return (await listPromotions()).filter(p => p.isLive);
}

const IMAGE_URL = /^https:\/\/\S+$/i;
const LINK_URL = /^(https:\/\/\S+|mailto:\S+@\S+|tel:\+?[0-9 ]+)$/i;
const ACCENT = /^#[0-9a-f]{6}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Checked {
  title: string;
  body: string;
  imageUrl: string | null;
  linkUrl: string | null;
  linkLabel: string | null;
  accent: string | null;
  isActive: boolean;
  startsOn: string | null;
  endsOn: string | null;
  sortOrder: number;
}

function check(input: PromotionInput): Checked {
  const title = input.title.trim();
  if (!title) throw new ConfigError('A title is required.');
  if (title.length > 80) {
    throw new ConfigError('A title is at most 80 characters.');
  }
  const body = input.body.trim();
  if (body.length > 300) {
    throw new ConfigError('The text is at most 300 characters.');
  }
  // The phone shows the picture and nothing else (officer direction), so a
  // card without one would be a blank.
  const imageUrl = input.imageUrl.trim() || null;
  if (!imageUrl) {
    throw new ConfigError(
      'A picture is required: the app shows the picture alone.'
    );
  }
  if (imageUrl.length > 500 || !IMAGE_URL.test(imageUrl)) {
    throw new ConfigError('The picture must be an https:// address.');
  }
  const linkUrl = input.linkUrl.trim() || null;
  if (linkUrl && (linkUrl.length > 500 || !LINK_URL.test(linkUrl))) {
    throw new ConfigError(
      'The link must be an https:// address, a mailto: or a tel: number.'
    );
  }
  const linkLabel = input.linkLabel.trim() || null;
  if (linkLabel && linkLabel.length > 40) {
    throw new ConfigError('The link text is at most 40 characters.');
  }
  const accent = input.accent.trim().toLowerCase() || null;
  if (accent && !ACCENT.test(accent)) {
    throw new ConfigError('The colour must be six hex digits, like #0f5c4c.');
  }
  const startsOn = input.startsOn.trim() || null;
  const endsOn = input.endsOn.trim() || null;
  for (const date of [startsOn, endsOn]) {
    if (date && !DATE.test(date)) {
      throw new ConfigError('Dates are YYYY-MM-DD.');
    }
  }
  if (startsOn && endsOn && startsOn > endsOn) {
    throw new ConfigError('The card cannot end before it starts.');
  }
  const sortOrder = Number(input.sortOrder.trim() || '0');
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 1000) {
    throw new ConfigError('The order is a whole number from 0 to 1000.');
  }
  return {
    title,
    body,
    imageUrl,
    linkUrl,
    // A label without a link says nothing.
    linkLabel: linkUrl ? linkLabel : null,
    accent,
    isActive: input.isActive,
    startsOn,
    endsOn,
    sortOrder,
  };
}

function actorFor(actor: Actor): ConfigurationActor {
  return { userId: actor.userId, description: actor.email };
}

export async function createPromotion(
  input: PromotionInput,
  actor: Actor
): Promise<string> {
  const p = check(input);
  return withConfigurationActor(actorFor(actor), async client => {
    const result = await client.query<{ id: string }>(
      `insert into app_promotion
         (title, body, image_url, link_url, link_label, accent, is_active,
          starts_on, ends_on, sort_order)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               case when $10::integer > 0 then $10::integer
                    else coalesce((select max(sort_order) + 10 from app_promotion), 10)
               end)
       returning id`,
      [
        p.title,
        p.body,
        p.imageUrl,
        p.linkUrl,
        p.linkLabel,
        p.accent,
        p.isActive,
        p.startsOn,
        p.endsOn,
        p.sortOrder,
      ]
    );
    return result.rows[0].id;
  });
}

export async function updatePromotion(
  id: string,
  input: PromotionInput,
  actor: Actor
): Promise<void> {
  const p = check(input);
  await withConfigurationActor(actorFor(actor), async client => {
    const result = await client.query(
      `update app_promotion
          set title = $2, body = $3, image_url = $4, link_url = $5,
              link_label = $6, accent = $7, is_active = $8,
              starts_on = $9, ends_on = $10, sort_order = $11
        where id = $1`,
      [
        id,
        p.title,
        p.body,
        p.imageUrl,
        p.linkUrl,
        p.linkLabel,
        p.accent,
        p.isActive,
        p.startsOn,
        p.endsOn,
        p.sortOrder,
      ]
    );
    if (result.rowCount === 0) {
      throw new ConfigError('That card no longer exists.', 'not_found');
    }
  });
}

export async function deletePromotion(id: string, actor: Actor): Promise<void> {
  await withConfigurationActor(actorFor(actor), async client => {
    const result = await client.query(
      'delete from app_promotion where id = $1',
      [id]
    );
    if (result.rowCount === 0) {
      throw new ConfigError('That card no longer exists.', 'not_found');
    }
  });
}
