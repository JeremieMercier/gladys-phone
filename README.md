# Gladys Phone — Gladys external integration

Receives live GPS positions pushed by the
Gladys Phone mobile app (even when the app
is closed) and forwards them to the Gladys user location, so presence scenes
trigger in real time.

Built from the official
[integration-template-js](https://github.com/GladysAssistant/integration-template-js)
with the [`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

## Architecture

```
Phone (native beacon, works with the app closed)
  │  POST /users/<selector>/positions
  │  Authorization: Bearer <Gladys API key>     {"points":[{latitude,…}]}
  ▼
Reverse proxy or VPN (user's own)
  ▼
"receiver" sub-container (published port, chosen by Gladys)
  │  translates the beacon format
  ▼
POST /api/v1/user/<selector>/location  (Gladys core REST API)
  ▼
Gladys user location → presence scenes, location history
```

Two containers from a single image:

- **main** (`index.js`): SDK glue — reads the config, starts the receiver
  sub-container with the core URL, reports health, answers the
  "Test the receiver" action;
- **receiver** (`receiver.js` → `src/server.js`): stateless HTTP server. The
  Bearer token forwarded by each phone **is** that user's Gladys API key —
  the receiver holds no secret, Gladys itself validates every request.

## User documentation

See [docs/fr.md](./docs/fr.md) (français) and [docs/en.md](./docs/en.md)
(English) — re-hosted by Gladys and linked from the Configuration screen.

## Development

```bash
npm install
npm test           # unit tests (node --test)
npm run lint
npm run format
```

Run the receiver alone against any Gladys instance:

```bash
RECEIVER_GLADYS_URL="http://192.168.1.10" RECEIVER_PORT=8080 npm run start:receiver

curl -X POST http://localhost:8080/users/<selector>/positions \
  -H "Authorization: Bearer <gladys-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"points":[{"latitude":45.5017,"longitude":-73.5673,"accuracy":8}]}'
```

Run the main container process locally (needs a Gladys with the integration
host API):

```bash
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="gladys-phone" \
npm start
```

Validate the manifest and repo layout like the store indexer does:

```bash
npx github:GladysAssistant/integration-store .
```

### Full test against a local Gladys (dev install, no publication needed)

Gladys requires a successful `docker pull` at install time, so an unpublished
image must be served by a local registry (see the `registry` service of the
companion `gladys-local/docker-compose.yml`, which also documents why Gladys
must run with host networking there):

```bash
docker build -t ghcr.io/jeremiemercier/gladys-phone:0.1.0 .
docker tag ghcr.io/jeremiemercier/gladys-phone:0.1.0 localhost:5001/gladys-phone:0.1.0
docker push localhost:5001/gladys-phone:0.1.0
```

Then install in dev mode through the Gladys API (`POST
/api/v1/external_integration` with `{docker_image, manifest}`, both pointing
at the `localhost:5001` image), set the `instance_url` config if the local
Gladys does not listen on port 80, and POST a beacon-format payload to the
receiver's published host port. Gotchas learned on the way:

- the assigned host port changes on every reinstall — read it from
  `docker ps` or the integration screen;
- never name a config key with a `gladys_` prefix: keys are stored
  uppercased server-side and the `GLADYS_` prefix is reserved, the value
  would be written but never read back (hence `instance_url`).

## License

Apache-2.0
