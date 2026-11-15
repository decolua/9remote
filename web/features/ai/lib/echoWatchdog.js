// Settle-once watchdog for an acked prompt whose user_message never came back:
// silence past the budget surfaces the prompt as resendable instead of blank.
export function createEchoWatchdog({ timeoutMs, schedule = setTimeout, clear = clearTimeout, onMissing }) {
  let timer = null;
  let done = false;
  return {
    arm() {
      if (done || timer != null) return;
      timer = schedule(() => {
        timer = null;
        if (done) return;
        done = true;
        onMissing?.();
      }, timeoutMs);
    },
    settle() {
      if (done) return;
      done = true;
      if (timer != null) { clear(timer); timer = null; }
    }
  };
}
