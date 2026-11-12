import { REPO_SCAN } from "../constants/terminalConfig";

// A panel mounted on a cold load asks the host before the bus exists and reads
// "Not connected" — transient, so bootstrap calls retry instead of pinning an empty panel.
export const isNotConnected = (res) => res?.error === "Not connected";

// Runs `request` until it stops answering "Not connected" or the backoff budget is spent.
// `isCurrent` lets the caller abandon the loop when its inputs changed or it unmounted.
export async function requestWithBusRetry(request, isCurrent = () => true) {
  let res = await request();
  let delay = REPO_SCAN.retryBaseMs;
  while (isNotConnected(res) && isCurrent() && delay <= REPO_SCAN.retryMaxMs) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (!isCurrent()) break;
    delay *= 2;
    res = await request();
  }
  return res;
}
