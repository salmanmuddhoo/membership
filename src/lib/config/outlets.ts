// Where the membership card earns a discount (migration 0116).
//
// An administrator writes the outlets on the Member app configuration
// page; the app lists the active ones by category. Writes go through
// withConfigurationActor like every other piece of configuration.
import { query, withConfigurationActor } from '../db/pool';
import { cached } from './cache';
import { ConfigError, type Actor } from './reference';
import type { ConfigurationActor } from '../db/pool';

export interface Outlet {
  id: string;
  name: string;
  logoUrl: string;
  category: string;
  // Decimal string, e.g. "10.00".
  discountPercent: string;
  description: string;
  address: string | null;
  linkUrl: string | null;
  isActive: boolean;
  // Pays the premium fee: on the home screen as well as under Cards.
  isPartner: boolean;
  sortOrder: number;
}

export interface OutletInput {
  name: string;
  logoUrl: string;
  category: string;
  discountPercent: string;
  description: string;
  address: string;
  linkUrl: string;
  isActive: boolean;
  isPartner: boolean;
  sortOrder: string;
}

interface Row {
  id: string;
  name: string;
  logo_url: string;
  category: string;
  discount_percent: string;
  description: string;
  address: string | null;
  link_url: string | null;
  is_active: boolean;
  is_partner: boolean;
  sort_order: number;
}

const SELECT = `select id, name, logo_url, category, discount_percent::text as discount_percent,
       description, address, link_url, is_active, is_partner, sort_order
  from card_outlet`;

function toOutlet(row: Row): Outlet {
  return {
    id: row.id,
    name: row.name,
    logoUrl: row.logo_url,
    category: row.category,
    discountPercent: row.discount_percent,
    description: row.description,
    address: row.address,
    linkUrl: row.link_url,
    isActive: row.is_active,
    isPartner: row.is_partner,
    sortOrder: row.sort_order,
  };
}

async function readOutlets(): Promise<Outlet[]> {
  const result = await query<Row>(
    `${SELECT} order by sort_order, category, name`
  );
  return result.rows.map(toOutlet);
}

// Every outlet, for the administrator.
export function listOutlets(): Promise<Outlet[]> {
  return cached('card-outlets', readOutlets);
}

// What the app shows under Cards.
export async function activeOutlets(): Promise<Outlet[]> {
  return (await listOutlets()).filter(o => o.isActive);
}

// What the app shows on its home screen.
export async function partnerOutlets(): Promise<Outlet[]> {
  return (await activeOutlets()).filter(o => o.isPartner);
}

// The tags in use, for the administrator's form to offer.
export async function outletCategories(): Promise<string[]> {
  return [...new Set((await listOutlets()).map(o => o.category))].sort();
}

const HTTPS_URL = /^https:\/\/\S+$/i;
const LINK_URL = /^(https:\/\/\S+|mailto:\S+@\S+|tel:\+?[0-9 ]+)$/i;
const PERCENT = /^\d{1,3}(\.\d{1,2})?$/;

interface Checked {
  name: string;
  logoUrl: string;
  category: string;
  discountPercent: string;
  description: string;
  address: string | null;
  linkUrl: string | null;
  isActive: boolean;
  isPartner: boolean;
  sortOrder: number;
}

function check(input: OutletInput): Checked {
  const name = input.name.trim();
  if (!name) throw new ConfigError('A name is required.');
  if (name.length > 80)
    throw new ConfigError('A name is at most 80 characters.');

  const logoUrl = input.logoUrl.trim();
  if (!logoUrl)
    throw new ConfigError('A logo is required: an https:// address.');
  if (logoUrl.length > 500 || !HTTPS_URL.test(logoUrl)) {
    throw new ConfigError('The logo must be an https:// address.');
  }

  const category = input.category.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!category)
    throw new ConfigError(
      'A category is required, such as "education" or "food".'
    );
  if (category.length > 30)
    throw new ConfigError('A category is at most 30 characters.');

  const discount = input.discountPercent.trim();
  if (
    !PERCENT.test(discount) ||
    Number(discount) <= 0 ||
    Number(discount) > 100
  ) {
    throw new ConfigError(
      'The discount is a percentage above 0 and up to 100, such as 10 or 12.5.'
    );
  }

  const description = input.description.trim();
  if (description.length > 200)
    throw new ConfigError('The description is at most 200 characters.');

  const address = input.address.trim() || null;
  if (address && address.length > 120)
    throw new ConfigError('The address is at most 120 characters.');

  const linkUrl = input.linkUrl.trim() || null;
  if (linkUrl && (linkUrl.length > 500 || !LINK_URL.test(linkUrl))) {
    throw new ConfigError(
      'The link must be an https:// address, a mailto: or a tel: number.'
    );
  }

  const sortOrder = Number(input.sortOrder.trim() || '0');
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 1000) {
    throw new ConfigError('The order is a whole number from 0 to 1000.');
  }

  return {
    name,
    logoUrl,
    category,
    discountPercent: discount,
    description,
    address,
    linkUrl,
    isActive: input.isActive,
    isPartner: input.isPartner,
    sortOrder,
  };
}

function actorFor(actor: Actor): ConfigurationActor {
  return { userId: actor.userId, description: actor.email };
}

export async function createOutlet(
  input: OutletInput,
  actor: Actor
): Promise<string> {
  const o = check(input);
  return withConfigurationActor(actorFor(actor), async client => {
    const result = await client.query<{ id: string }>(
      `insert into card_outlet
         (name, logo_url, category, discount_percent, description, address,
          link_url, is_active, is_partner, sort_order)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               case when $10::integer > 0 then $10::integer
                    else coalesce((select max(sort_order) + 10 from card_outlet), 10)
               end)
       returning id`,
      [
        o.name,
        o.logoUrl,
        o.category,
        o.discountPercent,
        o.description,
        o.address,
        o.linkUrl,
        o.isActive,
        o.isPartner,
        o.sortOrder,
      ]
    );
    return result.rows[0].id;
  });
}

export async function updateOutlet(
  id: string,
  input: OutletInput,
  actor: Actor
): Promise<void> {
  const o = check(input);
  await withConfigurationActor(actorFor(actor), async client => {
    const result = await client.query(
      `update card_outlet
          set name = $2, logo_url = $3, category = $4, discount_percent = $5,
              description = $6, address = $7, link_url = $8, is_active = $9,
              is_partner = $10, sort_order = $11
        where id = $1`,
      [
        id,
        o.name,
        o.logoUrl,
        o.category,
        o.discountPercent,
        o.description,
        o.address,
        o.linkUrl,
        o.isActive,
        o.isPartner,
        o.sortOrder,
      ]
    );
    if (result.rowCount === 0) {
      throw new ConfigError('That outlet no longer exists.', 'not_found');
    }
  });
}

export async function deleteOutlet(id: string, actor: Actor): Promise<void> {
  await withConfigurationActor(actorFor(actor), async client => {
    const result = await client.query('delete from card_outlet where id = $1', [
      id,
    ]);
    if (result.rowCount === 0) {
      throw new ConfigError('That outlet no longer exists.', 'not_found');
    }
  });
}
