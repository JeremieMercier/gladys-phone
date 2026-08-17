# Gladys Phone

This integration receives GPS positions pushed **live** by the
Gladys Phone mobile app — including when
the app is closed — and forwards them to the Gladys user location. Your
presence scenes (arriving / leaving home) trigger in real time, without
waiting for the app to be opened again.

It also exposes each phone as a **Gladys device** with its sensors — battery
level (%) and charging state — usable in your scenes ("phone battery below
20% → notification") and historized like any other sensor.

## How it works

1. On the phone, Gladys Phone records the position through a native service
   that survives the app being closed and the phone rebooting.
2. At a regular interval (configurable in the app), that service pushes the
   latest position to the **receiver** installed by this integration.
3. The receiver forwards the position to your Gladys through its official API
   (`/api/v1/user/…/location`): the same mechanism as the official Gladys
   app, so scenes and location history work identically.

Each phone authenticates with **its own Gladys API key** (created
automatically by the Gladys Phone app on login). The receiver stores no
secret: an invalid key is simply rejected by Gladys.

## Setup

1. Install the integration from the Gladys catalog.
2. In the configuration screen, note the receiver address shown in the
   "Getting started" block (`http://<your-gladys>:<port>`). The port is
   chosen by Gladys at install time.
3. Make that address reachable by your phone **away from home**:
   - **Reverse proxy** (recommended if you already run one — Nginx Proxy
     Manager, Traefik, Caddy…): create an HTTPS host, e.g.
     `https://tracks.mydomain.com`, pointing to the receiver address.
   - **VPN** (WireGuard, Tailscale…): if your phone stays connected to the
     VPN, the local address is enough.
4. In the Gladys Phone app, paste that public URL in the position sharing
   settings.
5. Click "Test the receiver" in the configuration screen to check everything
   is in place.

## Configuration

| Setting          | Description                                                                                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local Gladys URL | Address the receiver uses to reach your Gladys instance. Leave empty: it is detected automatically. Only set it if the test reports Gladys as unreachable (e.g. `http://192.168.1.10`). |

## Troubleshooting

- **"The receiver container does not answer"**: check the integration logs in
  the supervision screen.
- **"Gladys is not reachable"**: set your instance's local URL in the
  configuration (the one you use in your browser on your local network).
- **Positions do not arrive from outside**: check that the public URL
  (reverse proxy or VPN) reaches the receiver port — a
  `curl https://your-url/health` must answer `{"status":"ok"}`.
- **After reinstalling the integration**, Gladys may assign a new port to the
  receiver: update your reverse proxy entry.

## Exposing it to the Internet (best practices)

- Always expose the receiver over **HTTPS** (handled by the reverse proxy):
  the Gladys API key travels in every request.
- The receiver's internal control plane listens on a separate, never-published
  port: it stays unreachable from outside, and your reverse proxy only has
  access to the `/health`, `/users/…` and `/devices/…` routes.
- Where possible, enable **rate limiting** on your reverse proxy for the
  receiver host: unauthenticated requests are rejected, but a cap prevents an
  abusive flow from hammering your Gladys.

## Phone sensors

1. Enable sensor reporting in the Gladys Phone app settings (it is on by
   default once a receiver is configured).
2. Open this integration's screen in Gladys: the phone shows up in
   **discovery** under its name. Add it.
3. States (battery, charging) then flow in automatically, with their original
   timestamps.

Good to know:

- Sensors are sampled while the app runs (opening, returning to the
  foreground). Unlike positions, there is no "app closed for days" reporting:
  battery moves slowly, and pending readings leave on the next opening.
- States go through an in-memory buffer in the receiver: a container restart
  may lose at worst a few seconds of readings — position history is
  unaffected.
- Any valid Gladys API key of the household can push states: the trust model
  is the home, same as for positions.

## Accepted formats

The receiver accepts `POST /users/<selector>/positions` requests with an
`Authorization: Bearer <Gladys API key>` header and a body:

```json
{ "points": [{ "latitude": 45.5, "longitude": -73.5, "accuracy": 8.2 }] }
```

This is the format natively emitted by the Gladys Phone geolocation plugin;
other apps may use it as well.

For sensors: `POST /devices/<identifier>/states`, same
`Authorization: Bearer <Gladys API key>` header, and a body:

```json
{
  "device": { "name": "Jane's iPhone", "model": "iPhone15,2", "platform": "ios" },
  "states": [{ "sensor": "battery-level", "value": 87, "recorded_at": "2026-08-15T10:00:00Z" }]
}
```

Known sensors: `battery-level` (0–100) and `battery-charging` (0/1). Unknown
sensors are accepted then ignored — an app newer than the receiver never
loses its batch.
