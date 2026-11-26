// Staff access hours (officer request, 26 November 2026; migration 0131).
//
// The system can be closed to staff for part of every day — access.
// closed_hours, Mauritius time. A window whose start is later than its end
// runs past midnight (17:00 to 07:00 is the evening and the night that
// follows). Blank times leave the system open all day.
//
// Not held to it: the System Administrator role, so the window can never
// lock everyone out of the screen that sets it, and an account marked
// out_of_hours_access on the staff page. The middleware applies this to
// every staff request; the member app and the public API are not staff.
import { isSystemAdministrator, type Principal } from './principal';
import { TIME_ZONE } from '../time';

export interface ClosedHours {
  // HH:MM, or '' when the system is open all day.
  from: string;
  until: string;
}

export const OPEN_ALL_DAY: ClosedHours = { from: '', until: '' };

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isTime(text: string): boolean {
  return HH_MM.test(text);
}

function minutesOf(text: string): number {
  const [, h, m] = HH_MM.exec(text)!;
  return Number(h) * 60 + Number(m);
}

const clock = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: TIME_ZONE,
});

/** Minutes past midnight, Mauritius time. */
export function localMinutes(at: Date): number {
  const parts = clock.formatToParts(at);
  const hour = Number(parts.find(p => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find(p => p.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

/** Whether the system is closed to staff at this instant. */
export function isClosedAt(hours: ClosedHours, at: Date): boolean {
  if (!isTime(hours.from) || !isTime(hours.until)) return false;
  const from = minutesOf(hours.from);
  const until = minutesOf(hours.until);
  if (from === until) return false;
  const now = localMinutes(at);
  return from < until ? now >= from && now < until : now >= from || now < until;
}

/** Whether this person is held to the closed hours at all. */
export function heldToHours(principal: Principal): boolean {
  return !principal.outOfHoursAccess && !isSystemAdministrator(principal);
}
