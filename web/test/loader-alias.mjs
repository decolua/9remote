// Registers the @/ alias resolver. Loaded via --import.
// Node 22 ESM loader API requires register() from a --import module.
import { register } from "node:module";
import { pathToFileURL } from "node:url";
const hooks = pathToFileURL("./test/loader-alias-hooks.mjs").href;
register(hooks, import.meta.url);
