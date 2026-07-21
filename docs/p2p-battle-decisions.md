# P2P Battle Stage 1 Decisions

## Purpose

Stage 1 proves that two csTimer browser sessions can connect directly and exchange control and chat messages without an application server or online database. It is a transport spike, not yet a playable timed battle.

## Fixed product decisions

- The mode is a casual, host-trusted, private 1v1 experience.
- The host's browser tab owns the live peer session.
- The connection and all messages exist in memory only.
- Reloading or closing the host tab permanently ends that session.
- The existing Online Battle tool and its WebSocket protocol remain unchanged.
- Shared scrambles, timer events, solve results, Ready controls, match state, and persistent logs are deferred.

## Zero-backend connectivity model

The project owns no signaling service, game server, online database, or TURN relay. Pairing uses WebRTC non-trickle ICE and a manual two-way exchange:

1. The host selects **Create offer (Host)**.
2. csTimer gathers ICE candidates and creates an offer link and fallback code.
3. The host sends the link to the guest through an existing messaging app.
4. The guest opens the link, waits for an answer code, and returns that code to the host.
5. The host pastes the answer into the original still-open tab and selects **Connect**.
6. The `battle-control-v1` and `battle-chat-v1` data channels open directly between the browsers.

The offer and answer contain ephemeral SDP, ICE candidates, DTLS fingerprints, and session identifiers. They are kept in memory or the offer URL fragment and are never written to csTimer storage. The offer fragment is removed after a guest successfully imports it.

## External connectivity dependency

The peer configuration uses Google's public STUN endpoint at `stun:stun.l.google.com:19302`. STUN helps a browser discover a public-facing route and receives connection metadata such as IP address and port. It does not receive battle control or chat payloads.

There is deliberately no TURN fallback. Some carrier, enterprise, school, hotel, VPN, symmetric-NAT, or firewall configurations will therefore fail to connect. The UI must report **Direct connection unavailable without a relay server** instead of promising universal connectivity. Same-LAN connectivity should still work when direct host candidates are usable.

WebRTC data-channel payloads are encrypted in transit by the browser's WebRTC stack. The other peer necessarily learns connection-related network information during ICE negotiation.

## Stage 1 chat

- Chat is included to validate the second data channel.
- The host validates and canonicalizes messages.
- Text is rendered as text, never HTML.
- Each message is limited to 500 Unicode code points.
- Each peer is limited to five submissions per ten seconds.
- Chat history is memory-only and clears when the connection ends or the page reloads.

## Manual verification

Serve csTimer through HTTPS or localhost; clipboard and other browser features may be restricted on insecure non-local origins.

1. Build the local version with `make local` and serve `dist/local` on localhost.
2. Open the site in Chrome and choose **Tools → Online battle (P2P beta)**.
3. Create an offer and copy the offer link.
4. Open that link in Firefox.
5. Copy the generated answer code back into the original Chrome tab and connect.
6. Confirm both channels report open and chat works in both directions.
7. Repeat with Firefox as host and Chrome as guest.
8. Hide/switch the tool panel and confirm the peer connection stays open.
9. End the host session and confirm the guest reports that the host connection ended.
10. Confirm the old offer cannot be used to revive the closed host session.

For cross-network testing, put the browsers on different internet connections. A failure on a restrictive network without TURN is expected and should be clearly reported.

## Privacy verification

- Inspect localStorage and IndexedDB before and after pairing; no pairing/chat records should be added.
- Inspect network activity; apart from static csTimer assets and STUN/peer traffic, there must be no P2P Battle HTTP, WebSocket, database, analytics, or logging requests.
- Diagnostic UI must show state/error codes only and must not print full SDP or ICE candidates.
