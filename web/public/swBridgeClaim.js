// Which client may act as the bridge.
//
// The worker forwards every browsed request to whichever client announced
// itself with "bridge-hello", and every browsed site lives on this same origin.
// So a dev server rendering something the developer did not write can claim the
// role, then see every other tab's requests — paths, headers, bodies — and
// answer them with content of its own.
//
// The shell is the one page entitled to it, and the worker can tell: the shell
// is served at /proxy.html, while sites are always under /browse/. Parsing the
// URL rather than matching on the string is what makes /browse/3000/proxy.html
// and /browse/3000/../proxy.html answer correctly.
//
// Loaded by sw-site.js through importScripts, so this is a classic script and
// defines a global rather than exporting. The test reads and evaluates it.
function canBeBridge(clientUrl, expectedOrigin) {
  if (typeof clientUrl !== "string" || !clientUrl) return false;
  let url;
  try {
    url = new URL(clientUrl);
  } catch {
    return false;
  }
  if (url.origin !== expectedOrigin) return false;
  // pathname is already normalised by the URL parser, so ../ is resolved and a
  // query or fragment cannot smuggle the shell's name into it.
  return url.pathname === "/proxy.html";
}

// The one app origin that may sit above a browsed site. frame-ancestors is
// checked against EVERY ancestor, not just the parent, so a site framed by the
// shell is also framed by the app — naming only the shell blocks the load.
const APP_ORIGIN_BY_SITES_HOST = {
  "sites.9remote.cc": "https://9remote.cc",
  "sites-dev.9remote.cc": "https://dev.9remote.cc",
  "sites.localhost": "http://localhost:3000"
};

// "" for an unknown host: the policy then names the shell alone, which is the
// safe direction — a load fails rather than an unknown origin being allowed.
function appOriginFor(hostname) {
  return APP_ORIGIN_BY_SITES_HOST[String(hostname || "").toLowerCase()] || "";
}
