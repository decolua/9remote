// Base class for a CLI's screen vocabulary. A profile is CONFIG, not code:
//   detect.hints — distinct signals that this CLI owns the screen. Each hint is
//                  { test(line), weight }; a screen is claimed once the summed weight of
//                  DISTINCT hits reaches minWeight. Several weak hits or one strong one.
//   rules        — ordered line classifiers, exactly one of which may own a line
//                  (plus the terminal fallback). Each: { name, match(ctx), run(ctx) }.
//
// Subclasses declare data and may add helpers, but the pipeline (detector, extractor)
// never changes per CLI — that is the extension point for new CLIs.

export class CliProfile {
  static id = "generic";

  constructor() {
    this.id = this.constructor.id;
    this.detect = { hints: [], minWeight: 0 };
    this.rules = [];
    // Terminal rule evaluated last when nothing else matched. The generic profile
    // claims nothing — guessing at an unknown CLI's layout would invent conversation.
    this.fallback = null;
  }

  /** Score a screen: summed weight of distinct hints hit. */
  detectScore(lines) {
    const hit = new Set();
    let weight = 0;
    for (const line of lines) {
      for (let i = 0; i < this.detect.hints.length; i++) {
        if (hit.has(i)) continue;
        const h = this.detect.hints[i];
        if (h.test(line)) {
          hit.add(i);
          weight += h.weight || 1;
        }
      }
    }
    return weight;
  }

  owns(lines) {
    return this.detectScore(lines) >= this.detect.minWeight;
  }
}
