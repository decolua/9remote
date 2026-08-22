// Browser view (local sites over the transport bus) — shared config

export const SITE_SW_URL = "/sw-site.js";
export const SITE_SW_SCOPE = "/browse/";
export const SITE_NAV_EVENT = "site-nav";

// Must exceed the SW's own bridge timeout (60s) so the SW surfaces the error first
export const SITE_REPLY_TIMEOUT_MS = 75000;
export const SITES_FETCH_TIMEOUT_MS = 8000;
