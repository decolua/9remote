"use client";

import { Terminal } from "@/shared/components/ui/Icon";
import { agentIconUrl, AGENT_ICON_CLS } from "../constants/agentCli";
import { AGENT_ICONS } from "../constants/agentLabels";

// A terminal row's leading icon: the engine's bundled logo — UI engines get their
// own icon, a hook-reported tool falls back to the label's icon, and a plain shell
// gets a prompt glyph. Shared by the main tree and other hosts' trees.
export default function SessionAgentIcon({ agent = null, tool = null }) {
  // Callers may hand the picked option object; only its id names the engine.
  const agentId = typeof agent === "string" ? agent : (agent?.id || null);
  if (agentId?.endsWith("-ui")) {
    return <img src={agentIconUrl(agentId)} alt="" className={`w-3.5 h-3.5 flex-shrink-0 object-contain ${AGENT_ICON_CLS}`} />;
  }
  if (AGENT_ICONS[tool]) {
    return <img src={AGENT_ICONS[tool]} alt={tool} className={`w-3.5 h-3.5 flex-shrink-0 object-contain ${AGENT_ICON_CLS}`} />;
  }
  return <Terminal size={13.5} className="flex-shrink-0" />;
}
