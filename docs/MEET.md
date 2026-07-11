# RouteReady Meet — operations guide

RouteReady Meet is the first-party video meeting tool (`dashboard/meet.html`,
short links `/m/<code>`). Calls are peer-to-peer WebRTC; signaling rides
Supabase Realtime; rooms live in the `meetings` table (migrations 0457-0459).
This doc covers the pieces an operator can configure.

## TURN relay (reliability on hostile networks)

STUN-only connects fine on typical home, office, and mobile networks, but
two participants who are BOTH behind very strict NATs (some corporate
VPNs / hotel networks) can fail to get media through — the tile sits on
"connecting…". A TURN relay fixes that by carrying media when a direct
path can't be punched. Zoom runs its own relay fleet; we layer it in.

**Default (migration 0460):** when no operator relay is configured, calls
automatically include the Open Relay Project (openrelay.metered.ca —
Metered's free public TURN service). It's strictly additive: WebRTC only
uses a relay when the direct path fails, and ignores it entirely if the
relay is unreachable, so the worst case equals plain STUN. Media through
any TURN relay stays SRTP-encrypted end to end — the relay forwards
packets it cannot decrypt.

**Verify from a real network:** every lobby has a **"Test my connection"**
link that reports Local / STUN / Relay reachability — "Relay ✓" is the
strict-firewall guarantee. Use it when an applicant reports connection
trouble.

**Upgrade to an operator-owned relay** (guaranteed capacity, SLA, your
account): clients fetch their ICE server list from the database at join
time (`meet_ice_servers` RPC), so **it's one SQL INSERT — no deploy** —
and it overrides the public default the moment it's set:

```sql
insert into private.app_settings (key, value) values (
  'meet_turn_servers',
  '[{"urls":["turn:YOUR-TURN-HOST:443?transport=tcp","turns:YOUR-TURN-HOST:443?transport=tcp"],
     "username":"YOUR-USERNAME","credential":"YOUR-CREDENTIAL"}]'
) on conflict (key) do update set value = excluded.value, updated_at = now();
```

To disable again:

```sql
delete from private.app_settings where key = 'meet_turn_servers';
```

Notes:
- The value is a JSON **array** of RTCIceServer objects — you can list
  several servers.
- Port 443 with `?transport=tcp` (and a `turns:` TLS variant) gets through
  the strictest firewalls.
- Credentials are only handed to callers presenting a **valid, un-ended
  meeting code** (the RPC checks before answering), but treat them like any
  rentable secret: prefer providers with rotating/short-lived credentials
  and rotate static ones periodically.

### Where to get a TURN server

Any of these work — you only need the three values above:

| Option | Notes |
| --- | --- |
| **Cloudflare Calls TURN** | We already deploy on Cloudflare. Generous free tier. Their API mints short-lived credentials; for the static-credential shape above, generate long-lived creds from the dashboard. |
| **Metered.ca / Twilio NTS / Xirsys** | Managed TURN with static or API-minted credentials; free tiers exist. Fastest path: create account → copy urls/username/credential into the INSERT. |
| **Self-hosted coturn** | Full control, ~$5/mo VPS. Use `static-auth-secret` mode and mint credentials per policy. |

## Recording

Hosts (and DSP staff — anyone with the End-for-all button) get a record
button. Recording is **local**: the host's browser composites the gallery
and mixes all audio, and stopping downloads a `.webm` to their machine.
Nothing is uploaded to RouteReady or any third party. Every participant
sees a red **REC** pill and a toast the moment recording starts or stops.

## Waiting room

Guests (anyone without a RouteReady staff session) land in a waiting room;
staff see a "N waiting" chip and admit or deny each guest. This is a
cooperative gate for flow control — the unguessable meeting code remains
the actual security boundary, same as Zoom links with embedded passcodes.

## Background blur

Per-participant, in Settings (gear icon). Runs entirely on the
participant's own device (MediaPipe selfie segmentation, loaded on first
use from CDN); if their device/network can't load it, the toggle reverts
and the raw camera keeps flowing.

## Interview integration

Booked interviews mint Meet rooms automatically (`interview-room` edge
function). The confirmation email contains the `/m/<code>` link; the
operator's dashboard interview room embeds the same room next to the
notes/scorecard panel. Events created before the switch keep their old
meet.jit.si links, which continue to work.

- Optional edge-function secret: `MEET_PUBLIC_BASE_URL` overrides the base
  used for minted links (defaults to `https://gorouteready.com`).

## Known limits

- **Mesh topology**: comfortable to ~6-8 participants. Larger all-hands
  need an SFU (a media server) — separate infrastructure, not currently
  deployed.
- **Waiting room / recording indicators are cooperative**: enforced by the
  official client, not the server.
- Tab audio in screen share flows only where the browser offers it
  (Chrome/Edge tab shares; macOS system audio needs a virtual device).
