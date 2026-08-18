# Remote Desktop (custom WebRTC) — design

A self-contained remote-desktop capability for asmltr: stream a host machine's screen (and audio) to
any asmltr client (mobile app, TV app, dashboard), **drive** the host's mouse/keyboard back from the
client, let the assistant tap a stream and paint overlays on it, and route any source to any configured
sink. Think "an advanced VNC that the assistant can annotate and re-project."

**Non-negotiable:** asmltr owns the whole transport. It must NOT depend on any external overlay
(Pangolin, Tailscale, a corporate VPN). The client ships its own networking — every peer dials OUT to
the asmltr server, which provides signaling **and** its own STUN/TURN. No inbound ports on any host.

## Components

1. **Host agent** (`agents/host-remote-desktop/`, native, per machine) — a single self-contained binary.
   Go + [Pion](https://github.com/pion/webrtc) for WebRTC (pure-Go, cross-compiles Linux→Windows→a lone
   `.exe`). Responsibilities:
   - **Capture** the real desktop from Phase 1 (Windows: DXGI Desktop Duplication) + system audio
     (WASAPI loopback), encode (H.264/VP8, hardware where available), publish as WebRTC tracks. No
     synthetic/test-pattern stage — production capture from the first end-to-end test.
   - **Input injection** (Windows: `SendInput`) — apply mouse/keyboard events received on the control
     data channel. Gated: refuses control unless the session carries a control grant (see Trust).
   - Dials OUT to the asmltr signaling broker over an authenticated WebSocket; never listens for inbound.

2. **Signaling broker** (`connectors/types/remote-desktop/` or a core module) — asmltr, Node. The
   rendezvous + control plane, NOT the media path:
   - Sources register (`hello` → `{ host_id, name, caps }`); clients list available hosts.
   - Relays SDP offers/answers + ICE candidates between a chosen source and a viewer.
   - Issues short-lived STUN/TURN credentials (see Transport) per session.
   - Enforces per-host view/control permissions (Trust) and logs every session to the event stream.
   - Media never transits this layer at the application level (TURN relay is separate; see Transport).

3. **Clients** (viewer + controller) — reuse the WebRTC client pattern from live-STT:
   - **Mobile app** (`mobile/www/`): view the track; a "take over" layer maps touch→mouse (tap=click,
     drag=move) and an on-screen keyboard→keystrokes over the control data channel.
   - **TV app** (later): PiP → full-screen; D-pad drives a cursor (center=click) + soft keyboard.
   - **Assistant tap**: the assistant subscribes as a viewer to see a host, samples frames on demand,
     and sends **overlay draw-commands** over a data channel that each viewer renders atop the video
     (client-side compositing — light, per-viewer, no server mixing).

4. **Display matrix** — config of which sources may project to which sinks; the assistant routes
   "host X + my overlay → sink(s)". Sinks are registered client devices.

## Transport (asmltr owns it — no external overlay; DIRECT hole-punched media)

Goal: media flows **peer-to-peer via NAT hole punching**; asmltr is the negotiator, not the relay.

- Every peer holds an outbound authenticated connection to the asmltr server (the agent's signaling WS;
  the app's existing device gateway). No host needs a public IP or a forwarded port.
- **NAT hole punching is first-class.** asmltr runs its own **STUN** service so each peer discovers its
  server-reflexive (public) address; the broker relays ICE candidates between the two peers; full ICE
  then punches a direct hole and the video flows **peer-to-peer — the server never sees the media.**
  This is standard trickle-ICE (Pion supports it) and works for the large majority of NAT types
  (full-cone / restricted / port-restricted, incl. most home routers).
- **TURN is a rare, explicit last resort — never the default.** The one case direct cannot win is
  symmetric-NAT on BOTH ends at once (some carrier-grade mobile NAT); no technique hole-punches that, so
  TURN relay is the only physical option. asmltr can run its own TURN for that fallback, but it is
  **opt-in / disable-able** (`ASMLTR_RD_TURN=off` → direct-or-nothing). When enabled, TURN creds are
  short-lived, minted per session, and the UI should show when a session is relayed vs. direct.
- We do NOT relay video through the application layer under any config. The only server-side media path
  that can ever exist is the optional TURN fallback above.

## Signaling wire protocol (the contract)

Authenticated WebSocket to the broker. JSON messages, `{ type, ... }`:

- **agent→broker** `register` `{ host_id, name, caps:{video,audio,control} }` → broker replies
  `registered` `{ host_id }`.
- **client→broker** `list` → `hosts` `[{ host_id, name, caps, online }]`.
- **client→broker** `connect` `{ host_id, want:{control?} }` → broker checks permission, allocates a
  `session_id` + TURN creds, and forwards `offer_request` to the agent.
- **{agent,client}→broker** `sdp` `{ session_id, sdp }` and `ice` `{ session_id, candidate }` — relayed
  verbatim to the other peer of that session. (SDP/ICE are the only things the broker forwards.)
- **control** (mouse/keyboard) and **overlay** (draw-commands) travel on WebRTC **data channels**
  peer-to-peer, never through the broker. Control is only opened when the session carries a control grant.
- **broker→both** `bye` `{ session_id, reason }` tears a session down.

## Trust / security (first-class, from commit #1)

Remote keyboard+mouse control of a machine is the most powerful capability we build. Therefore:

- **View** and **control** are separate grants, per host, tied to the caller's resolved trust identity
  (default-deny). A viewer is not a controller unless explicitly granted.
- The agent **re-checks** the control grant itself (defense in depth) — it will not inject input for a
  session the broker didn't stamp with control.
- Every session (who, which host, view vs control, start/stop) is logged to the event stream.
- Consider an explicit **confirm-to-control** prompt on the host for the first takeover of a session.

## Phases (dependency order — every piece production-grade, no throwaway)

Built in dependency order because media can't travel before the control plane exists — but each
component is production-intent from the start (no synthetic tracks, no lightweight stand-ins).

- **P1 — real desktop, end-to-end, hole-punched.** Signaling broker (SDP/ICE relay + STUN + trust) →
  native Go/Pion agent doing real DXGI screen capture → mobile viewer renders it, media **direct
  peer-to-peer via ICE hole punching**. The first end-to-end test shows the actual desktop.
- **P2 — control.** `SendInput` on the agent + touch→mouse / soft-keyboard on mobile. Trust-gated.
- **P3 — assistant tap + overlay + display matrix.** Frame sampling, overlay draw-commands, source→sink routing.
- **P4 — TV client** (PiP, D-pad cursor) + system audio + multi-source + permission hardening.

Build sub-order within P1 (each real, not throwaway): (a) signaling broker + STUN + trust gate;
(b) native agent: signaling client → DXGI capture → H.264 encode → Pion publish; (c) mobile viewer:
connect via broker → ICE → render track. First test host: a reachable Windows box. First sink: the mobile app.
