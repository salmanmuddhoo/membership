import { defineMiddleware } from 'astro:middleware';
import { createSupabaseServerClient } from '@lib/supabase/server';

const LOGIN_PATH = '/login';
const HOME_PATH = '/dashboard';

// Central authentication guard. Runs for every page request:
//  - resolves the current user from the Supabase session cookie
//  - redirects the root to the appropriate place
//  - keeps signed-in users out of the login page
//  - default-denies every other route to unauthenticated users
export const onRequest = defineMiddleware(async (context, next) => {
  let user = null;

  try {
    const supabase = createSupabaseServerClient(context);
    const {
      data: { user: resolvedUser },
    } = await supabase.auth.getUser();
    user = resolvedUser ?? null;
  } catch (error) {
    // A misconfiguration or transient Supabase error should not take the
    // whole site down with a 500 — treat the request as signed out and log it.
    console.error('[auth] Failed to resolve session:', error);
    user = null;
  }

  context.locals.user = user;

  const { pathname } = context.url;

  if (pathname === '/') {
    return context.redirect(user ? HOME_PATH : LOGIN_PATH);
  }

  if (user && pathname === LOGIN_PATH) {
    return context.redirect(HOME_PATH);
  }

  if (!user && pathname !== LOGIN_PATH) {
    return context.redirect(LOGIN_PATH);
  }

  return next();
});
