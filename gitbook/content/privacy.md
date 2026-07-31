# Privacy Policy

**Last updated: July 31, 2026**

9Remote ("we", "the app") lets you reach your own computers — terminal, desktop, and files — from a phone or browser. This policy explains what data we handle and why.

## The short version

Your terminal output, screen frames, keystrokes, and files travel directly between your device and your own computer. We do not store them, and in most sessions they never pass through our servers at all.

## What we collect

**Account data.** Email address and a hashed authentication token, used to sign you in and link your devices.

**Device data.** A device name, operating system, and a generated device ID, used so you can identify and approve your own machines.

**Session metadata.** Connection timestamps and which device connected to which — used for the session list and for security auditing.

**Purchase data.** If you subscribe, the app store (Apple or Google) sends us a purchase receipt and a subscription identifier so we can unlock paid features. We never see your payment card.

**Push token.** If you enable notifications, a push token from Apple or Google so we can deliver alerts you asked for.

**Diagnostics.** Crash and error reports, with no session content included.

## What we do not collect

- Terminal input or output
- Screen images or recordings
- File contents you browse, upload, or download
- Passwords or SSH keys stored on your machines
- Advertising or tracking identifiers

## How your connection works

Sessions are end-to-end between your phone and your computer, over WebRTC or an encrypted WebSocket carried by a Cloudflare tunnel. Our servers perform signaling — introducing the two endpoints to each other — and then step out of the data path. When a direct peer-to-peer path cannot be established, traffic is relayed through a TURN server, which forwards encrypted packets without the ability to read them.

## Third parties

- **Cloudflare** — tunneling, hosting, and relay infrastructure
- **Apple / Google** — app distribution, in-app purchases, push notifications

We do not sell your data, and we do not share it with advertisers.

## Retention

Account and device records are kept while your account is active. Session metadata is kept for 90 days. Deleting your account removes all of it.

## Your rights

You may request access to, correction of, or deletion of your data at any time. Deleting the app does not delete your account — email us to close it.

## Children

9Remote is not directed at children under 13, and we do not knowingly collect their data.

## Changes

We will post any update to this page and revise the date above.

## Contact

privacy@9remote.cc
