// The one thing this needs to do is exist and answer fetch — a registered
// service worker with a fetch handler is what tells a browser this is
// actually installable, not just a page with a manifest attached. Nothing
// here caches or works offline: every request still goes straight to the
// network, since a stale cache of a form an officer is filling in, or of a
// member's balance, is worse than no offline mode at all.
self.addEventListener('fetch', () => {});
