// The profile for everything we do not know. It declares no patterns and claims no
// lines — an unknown CLI's layout must not be guessed at, or the parser invents
// conversation that was never said.
import { CliProfile } from "../CliProfile.js";

export class GenericProfile extends CliProfile {
  static id = "generic";

  constructor() {
    super();
    this.fallback = null; // claim nothing
  }
}
