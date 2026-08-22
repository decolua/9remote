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
