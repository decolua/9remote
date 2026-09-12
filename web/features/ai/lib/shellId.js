// A background shell's tool_result is not the command's output — it is the host
// saying "Command running in background with ID: b367hw0hy. Output is being written
// to: …". That id is what later reads (BashOutput / TaskOutput) report on, so the
// card keeps it to name the shell the user would have to ask about.
const SHELL_ID = /Command running in background with ID:\s*([^\s.]+)/;

export function shellIdFromResult(output) {
  const m = SHELL_ID.exec(typeof output === "string" ? output : "");
  return m ? m[1] : "";
}
