// Which CLI owns this screen? Profiles answer in priority order; the first to reach
// its hint quota claims it. A screen nothing claims returns null — the caller renders
// it plainly rather than guessing.
import { ClaudeProfile } from "./profiles/claude.js";

// Priority = specificity. New CLIs append here; they never edit the detector.
const REGISTRY = [ClaudeProfile];

export function detectCli(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  for (const Profile of REGISTRY) {
    const profile = new Profile();
    if (profile.owns(lines)) return profile;
  }
  return null;
}
