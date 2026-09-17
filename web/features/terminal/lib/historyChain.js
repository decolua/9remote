// Self-continued history fetch. A chunk of scrollback can render no new lines above the reader
// (pure repaint, ANSI-only), leaving them parked at the top with nothing to show for the fetch.
// Continue on their behalf — bounded, and paced, so it reads as one gesture rather than a loop.
export function createHistoryChain({ fetchOlder, isAtTop, max, delayMs }) {
  let spent = 0;
  let timer = null;

  const stop = () => {
    if (timer) { clearTimeout(timer); timer = null; }
  };

  return {
    // A user gesture at the top opens a fresh budget. Only a fetch that actually STARTED opens
    // it — a no-op gesture must not refill the budget the chain is partway through spending.
    gesture() {
      stop();
      if (!fetchOlder(false)) return;
      spent = 0;
    },
    // A prefix landed and the viewport has settled: go again only if the reader is still at the
    // top and the gesture has budget left. The delay keeps a repaint from reading as momentum.
    settled() {
      if (!isAtTop()) { spent = 0; return; }
      if (spent >= max) return;
      spent += 1;
      stop();
      timer = setTimeout(() => { timer = null; fetchOlder(true); }, delayMs);
    },
    cancel: stop
  };
}
