// What everyone signed in to the member app is told about the app itself
// (migration 0118): a new partner outlet, a promotion card gone live. Raised
// by the configuration writers (config/outlets.ts, config/promotions.ts)
// after the change has committed, the way the ledger raises its own — never
// inside the transaction, never failing what raised it (notify.ts's
// bargain). Push only: the recipient is every live phone.
import type { Outlet } from '../config/outlets';
import type { Promotion } from '../config/promotions';
import { notify } from './notify';
import { PUSH_EVERYONE } from './push';

export const PARTNER_ADDED = 'partner.added';
export const PROMOTION_PUBLISHED = 'promotion.published';

const percent = (decimal: string): string => {
  const n = Number(decimal);
  return `${Number.isFinite(n) ? (Number.isInteger(n) ? n : n.toFixed(1)) : decimal}%`;
};

/** An outlet that is now a partner, and active. Never throws. */
export async function notifyPartnerAdded(outlet: Outlet): Promise<string[]> {
  try {
    return await notify({
      eventCode: PARTNER_ADDED,
      recipients: { push: PUSH_EVERYONE },
      values: {
        outlet_name: outlet.name,
        category: outlet.category,
        discount: percent(outlet.discountPercent),
      },
      entityType: 'card_outlet',
      entityId: outlet.id,
    });
  } catch (error) {
    console.error('[app-events] could not announce the partner:', error);
    return [];
  }
}

/** A promotion card that is now live on the home screen. Never throws. */
export async function notifyPromotionPublished(
  promotion: Promotion
): Promise<string[]> {
  try {
    return await notify({
      eventCode: PROMOTION_PUBLISHED,
      recipients: { push: PUSH_EVERYONE },
      values: { title: promotion.title, body: promotion.body },
      entityType: 'app_promotion',
      entityId: promotion.id,
    });
  } catch (error) {
    console.error('[app-events] could not announce the promotion:', error);
    return [];
  }
}
