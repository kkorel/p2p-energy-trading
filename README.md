# P2P Energy Trading on Beckn

A peer-to-peer marketplace where households with rooftop solar sell surplus energy to other consumers in hourly delivery blocks over the Beckn protocol, with an AI trading agent, Oorja, that buyers and sellers can use in English or 10 Indian languages, by text or voice, on the web, WhatsApp or Telegram.

> **Status:** built in January and February 2026 by a team of four for the India Energy Stack / Beckn DEG peer-to-peer energy-trading pilot network. The hosted demo is offline and the pilot network's services may be too; discovery falls back to the app's own catalogue, so it still runs locally. This repository is a cleaned snapshot shared for portfolio viewing, and the original commit history was not carried over. See [Team](#team).

## What it does

- **Trading over Beckn.** One Express service acts as both the buyer application (BAP) and the seller application (BPP). Sellers publish offers to a Beckn catalogue service; buyers discover, select, init and confirm through the protocol's asynchronous request and callback flow.
- **Credential-gated onboarding.** New accounts upload W3C verifiable credentials issued by their utility (customer, consumption profile, generation or storage profile). They are checked for structure, dates and proof, and normalised claims such as installed capacity are extracted from them. Fictional sample credentials are in `scripts/sample-vcs`.
- **Matching.** Offers are scored on price, seller trust and time-window fit with configurable weights, and bulk orders are filled across several sellers.
- **Trust and settlement.** A mock DISCOM verifies delivery; seller trust rises with verified deliveries, falls with failures and cancellations, and sets a tiered trade limit. Escrow and payments are simulated.
- **Oorja, the trading agent.** Conversational onboarding, buying, selling and auto-trading. An LLM (via OpenRouter) handles intent detection and extracting data from uploaded PDFs; Sarvam provides Indian-language translation, speech-to-text and text-to-speech.
- **Solar and weather.** Rooftop solar potential from the Google Solar API, including annual-flux heatmaps rendered from GeoTIFF, sets a new seller's initial trade limit; weather data adjusts expected generation and drives maintenance alerts.

## Architecture

```
  Web app (Next.js 16)   WhatsApp (Baileys)   Telegram
            \                  |                 /
             v                 v                v
   +--------------------------------------------------------+
   |  API: Express + TypeScript              packages/bap   |
   |   BAP: discover / select / init / confirm              |
   |   BPP: catalogue, orders, on_* callbacks               |
   |   Oorja chat agent ---> OpenRouter (LLM), Sarvam       |
   |   mock DISCOM, trust engine, simulated escrow          |
   +--------------------------------------------------------+
        |                         |                    |
   PostgreSQL (Prisma)    Redis: sessions,       Beckn pilot network:
                          transaction state,     catalogue service,
                          distributed locks      trade ledger, VC portal
```

`packages/shared` holds what the API is built on: the Prisma schema, configuration, matching, the trust engine, credential verification, Beckn signing, and the solar and weather clients.

## Where to look

| Area | Files |
|---|---|
| Verifiable-credential verification and claim extraction, with 69 tests | `packages/shared/src/vc/verifier.ts`, `verifier.test.ts` |
| Filling a bulk order across several sellers | `packages/shared/src/matching/bulk-matcher.ts` |
| Offer scoring and filtering, with 48 tests | `packages/shared/src/matching/matcher.ts`, `matcher.test.ts` |
| No overselling of hourly blocks: `SELECT … FOR UPDATE SKIP LOCKED` in a transaction, plus Redlock | `packages/bap/src/seller-catalog.ts`, `packages/shared/src/db/lock.ts` |
| Trust score and tiered trade limits | `packages/shared/src/trust/trust-engine.ts` |
| Ed25519 / BLAKE2b-512 Beckn HTTP signatures | `packages/shared/src/beckn/signing.ts` |
| WhatsApp front end and voice replies | `packages/bap/src/chat/whatsapp.ts`, `sarvam-tts.ts` |

## Team

- [Aryan Jain](https://github.com/aryan-the-jain)
- [Emir Hurturk](https://github.com/ehurturk)
- [Vivaan Gupta](https://github.com/vivaan1304)
- [Kuzey Korel](https://github.com/kkorel)

## Quickstart

You need Node.js 20.9 or newer and Docker with the Compose plugin. The commands are for a POSIX shell; on Windows use Git Bash or WSL.

```bash
git clone https://github.com/kkorel/p2p-energy-trading.git
cd p2p-energy-trading
npm ci                        # if this fails on libsignal or EALLOWGIT, see Known issues
cp .env.example .env
set -a; source .env; set +a   # export the variables: the API reads DATABASE_URL before it loads any .env file
npm run setup                 # start PostgreSQL 15 and Redis 7 in Docker and wait for both
npm run db:push               # create the schema and generate the Prisma client
npm run seed                  # two demo sellers with solar offers for tomorrow
npm run dev:all               # API on http://localhost:4000, web app on http://localhost:3000
```

Open http://localhost:3000 and sign in with any Indian mobile number (ten digits starting 6 to 9) and the OTP `123456`. The OTP is hardcoded and no SMS is sent. A new account must upload two credential files before it can trade: use `scripts/sample-vcs/utility-customer.json` plus `consumption-profile.json` to buy, or `generation-profile-solar.json` to sell. `curl localhost:4000/health` reports the database and Redis status.

## Usage

The web app covers these flows on its Buy, Sell and Orders pages. The same calls over HTTP look like this; `jq` pulls ids out of the responses.

### Create an account and get a session token

```bash
BASE=http://localhost:4000
curl -s -X POST $BASE/auth/send-otp -H 'Content-Type: application/json' -d '{"phone":"9876543210"}'
USER_ID=$(curl -s -X POST $BASE/auth/verify-otp -H 'Content-Type: application/json' \
  -d '{"phone":"9876543210","otp":"123456","name":"Asha"}' | jq -r .userId)
for f in utility-customer consumption-profile generation-profile-solar; do
  curl -s -X POST $BASE/auth/verify-credential-preauth -H 'Content-Type: application/json' \
    -d "{\"userId\":\"$USER_ID\",\"credential\":$(cat scripts/sample-vcs/$f.json)}" | jq .signupReady
done
TOKEN=$(curl -s -X POST $BASE/auth/complete-signup -H 'Content-Type: application/json' \
  -d "{\"userId\":\"$USER_ID\"}" | jq -r .token)
```

On later logins `verify-otp` returns the token directly, because the credentials are already on file. Credentials are checked for structure, dates and proof; a proof whose issuer DID cannot be resolved produces a warning, not a failure, which is why the samples verify offline.

### Discover offers and buy

```bash
DISCOVERY=$(curl -s -X POST $BASE/api/discover -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" -d '{"sourceType":"SOLAR","minQuantity":5}')
TX=$(echo "$DISCOVERY" | jq -r .transaction_id)
OFFER=$(echo "$DISCOVERY" | jq -r '.catalog.providers[0].items[0].offers[0].id')
curl -s -X POST $BASE/api/select -H 'Content-Type: application/json' \
  -d "{\"transaction_id\":\"$TX\",\"offer_id\":\"$OFFER\",\"quantity\":5}"
curl -s -X POST $BASE/api/init -H 'Content-Type: application/json' -d "{\"transaction_id\":\"$TX\"}"
sleep 1   # the seller side answers init through an asynchronous on_init callback
curl -s -X POST $BASE/api/confirm -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" -d "{\"transaction_id\":\"$TX\"}"
curl -s $BASE/api/my-orders -H "Authorization: Bearer $TOKEN"
```

Discovery queries the external catalogue service and falls back to the local catalogue, which holds the seeded offers, when that service is unreachable or returns nothing. Confirm requires a verified consumption credential. New accounts start with a balance of 10,000 INR.

### List energy for sale

```bash
DAY=$(node -e "console.log(new Date(Date.now() + 864e5).toISOString().slice(0, 10))")
curl -s -X POST $BASE/seller/offers/direct -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"source_type\":\"SOLAR\",\"price_per_kwh\":6.5,\"currency\":\"INR\",\"max_qty\":20,
       \"time_window\":{\"startTime\":\"${DAY}T08:00:00Z\",\"endTime\":\"${DAY}T12:00:00Z\"}}"
```

Selling needs a verified generation or storage credential. Uploading one creates the seller profile and sets production capacity from the credential's installed capacity. Delivery windows snap to whole hours between 06:00 and 18:00 in the server's local time, must start at least four hours ahead and at most seven days ahead. New offers are also published to the external catalogue service in the background.

## Configuration

Copy `.env.example` to `.env` and export it into your shell before running the API or the seed (`set -a; source .env; set +a`). When started through the npm scripts the API also loads `packages/bap/.env`, but only after it has already read `DATABASE_URL`, so that one must come from the environment. `docker-compose.prod.yml` passes the same variables into the containers. Defaults below are the code's defaults; `.env.example` sets different values for `DISCOM_SUCCESS_RATE`, `DISCOM_CHECK_INTERVAL_MS`, `BECKN_SUBSCRIBER_ID`, `OPENROUTER_MODEL` and `EXTERNAL_CDS_URL` (the last resolves to the same endpoints). The pilot-network endpoints were run by the pilot's operators and may no longer respond.

| Variable | Default | Required | What it controls |
|---|---|---|---|
| `DATABASE_URL` | none | yes | PostgreSQL connection string |
| `REDIS_URL` | `redis://localhost:6379` | in production | Redis, used for sessions, transaction state and locks |
| `BAP_PORT` | `4000` | no | API listen port |
| `NODE_ENV` | unset | no | `development` turns on Prisma query logging; `production` makes `REDIS_URL` required and disables `POST /auth/reset-meter` (the other reset endpoints stay open, see [Security and limitations](#security-and-limitations)) |
| `DEV_MODE` | unset | no | `true` re-enables `POST /auth/reset-meter` in production |
| `CORS_ORIGINS` | `*` | no | Comma-separated allowed origins |
| `SESSION_EXPIRY_DAYS` | `7` | no | Session lifetime |
| `DEBUG` | unset | no | Any value prints debug-level logs |
| `BAP_ID`, `BAP_URI` | `bap.p2p-trading.local`, `http://localhost:4000` | no | This app's buyer identity in Beckn message contexts |
| `BPP_ID`, `BPP_URI` | `bpp.p2p-trading.local`, `http://localhost:4000` | no | This app's seller identity |
| `BPP_URL` | `http://localhost:4000` | no | Where the buyer side posts select, init, confirm and status for local offers |
| `EXTERNAL_CDS_URL` | `https://34.93.141.21.sslip.io/beckn/catalog` | no | Pilot-network catalogue service; publishing posts to its `/catalog/publish`, discovery to its `/discover` (`CDS_URL` is a fallback alias for publishing) |
| `CDS_URI` | `https://34.93.141.21.sslip.io/beckn` | no | Catalogue service base URL reported by `GET /api/diagnosis` |
| `BECKN_DOMAIN` | `beckn.one:deg:p2p-trading-interdiscom:2.0.0` | no | Domain stamped on outgoing messages |
| `UTILITY_ID` | `BESCOM-KA` | no | Utility id attached to published catalogues |
| `LEDGER_URL` | `https://34.93.166.38.sslip.io` | no | Pilot-network trade ledger |
| `ENABLE_LEDGER_WRITES` | `false` | no | `true` writes confirmed trades to the ledger |
| `DISCOM_ID_BUYER`, `DISCOM_ID_SELLER` | `DISCOM_BUYER_DEFAULT`, `DISCOM_SELLER_DEFAULT` | no | DISCOM ids written on ledger records |
| `BECKN_SIGNING_ENABLED` | `false` | no | Sign outgoing Beckn messages (Ed25519) |
| `BECKN_VERIFY_SIGNATURES` | `false` | no | Meant to reject incoming messages with a missing or invalid signature, but the verification middleware is not mounted on any route, so it currently has no effect |
| `BECKN_KEY_ID`, `BECKN_PUBLIC_KEY`, `BECKN_PRIVATE_KEY` | none | no | Buyer-side signing key; a throwaway pair is generated at startup when absent |
| `BPP_KEY_ID`, `BPP_PUBLIC_KEY`, `BPP_PRIVATE_KEY` | none | no | Seller-side key for catalogue publishing; falls back to the buyer-side key |
| `BECKN_SUBSCRIBER_ID` | `p2p-energy-bap` | no | Subscriber id in signature headers |
| `BECKN_SIGNATURE_TTL` | `30` | no | Signature validity in seconds |
| `VC_PORTAL_URL` | `https://open-vcs.up.railway.app` | no | Pilot-network portal used to fetch a credential by id |
| `RCW_IDENTITY_URL` | unset | no | Sunbird RC identity service for resolving `did:rcw` issuers during proof checks |
| `OPENROUTER_API_KEY` | unset | no | LLM calls for the chat agent and for extracting credentials and meter data from PDFs |
| `OPENROUTER_MODEL` | `openai/gpt-4o-mini` for chat, `meta-llama/llama-3.2-3b-instruct:free` for PDF extraction | no | OpenRouter model |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | no | OpenRouter endpoint |
| `TELEGRAM_BOT_TOKEN` | unset | no | Starts the Telegram bot when set |
| `WHATSAPP_ENABLED` | `false` | no | `true` starts the WhatsApp bot (Baileys); scan the QR code printed in the terminal |
| `WHATSAPP_BOT_NUMBER` | unset | no | Number linked to the WhatsApp bot, international format without `+`; used for wa.me links in chat |
| `APP_URL` | `http://localhost:3000/` | no | Web app URL the chat agent sends to unregistered WhatsApp users |
| `SARVAM_API_KEY` | unset | no | Indian-language translation, speech-to-text and text-to-speech in chat |
| `GOOGLE_SOLAR_API_KEY`, `GOOGLE_MAPS_API_KEY` | unset | no | Rooftop solar analysis of the credential address at onboarding, which sets the initial trade limit |
| `MATCH_WEIGHT_PRICE`, `MATCH_WEIGHT_TRUST`, `MATCH_WEIGHT_TIME` | `0.40`, `0.35`, `0.25` | no | Offer-scoring weights |
| `MIN_TRUST_THRESHOLD` | `0.2` | no | Minimum seller trust score for matching |
| `DEFAULT_TRUST_SCORE` | `0.5` | no | Trust assumed for network sellers with no history |
| `PLATFORM_FEE_RATE` | `0.025` | no | Only used to reconstruct the refund when a seller cancels; the 2.5% fee charged at purchase is hardcoded |
| `SELLER_CANCEL_PENALTY_RATE` | `0.05` | no | Fee when a seller cancels |
| `CANCEL_WINDOW_MINUTES` | `30` | no | Minutes after an order is placed during which the seller can still cancel it |
| `CALLBACK_DELAY` | `100` | no | Delay in ms before the seller side sends `on_*` callbacks |
| `DISCOM_SUCCESS_RATE`, `DISCOM_CHECK_INTERVAL_MS`, `DISCOM_RATE_PER_KWH` | `0.85`, `60000`, `10` | no | Mock DISCOM: share of deliveries verified as successful, polling interval, DISCOM tariff in INR per kWh used to price undelivered energy |
| `TRUST_SUCCESS_BONUS`, `TRUST_FAILURE_PENALTY`, `TRUST_CANCEL_PENALTY`, `TRUST_SELLER_CANCEL_PENALTY` | `0.02`, `0.10`, `0.03`, `0.05` | no | Trust score changes for a verified delivery, a failed delivery, a cancel received over Beckn and a seller cancellation |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | no | API that the Next.js server proxies `/api`, `/auth`, `/seller`, `/callbacks` and `/chat` to; also a build argument of the web Docker image |

## Development

Three npm workspaces: `packages/bap` is the Express API and runs from source with ts-node in development; `packages/shared` holds the Prisma schema, configuration, matching, trust engine, credential verification and Beckn signing, and is consumed from source; `packages/web` is the Next.js 16 app.

```bash
npm run dev:bap                                              # API only
npm run dev:web                                              # web app only
npm run start:all:clean                                      # start Docker, reset and seed the database, then dev:all
npm run build                                                # tsc for shared and bap, next build for web
npm run lint                                                 # ESLint on the web package, the only workspace with a linter
npm test                                                     # backend Jest suites; needs the Docker PostgreSQL and Redis running
npm run test:frontend                                        # web component tests in jsdom
npm run playwright:install -w @p2p/web && npm run test:e2e   # browser smoke tests; starts the web dev server itself
npm run db:studio                                            # Prisma Studio
npm run db:reset:seed                                        # drop and recreate the schema, then seed
```

The backend suites run one file at a time against the same PostgreSQL and Redis as development and delete providers, offers and orders as they go. After changing `packages/shared/prisma/schema.prisma`, run `npm run db:push` again. Postman collections for the pilot network's BAP, BPP, utility BPP and ledger APIs are published in the [DEG inter-DISCOM devkit](https://github.com/beckn/DEG/tree/p2p-trading/testnet/p2p-trading-interdiscom-devkit).

## Security and limitations

This was built as a time-boxed pilot demo, not for production. Don't deploy it as it stands. The known gaps:

- **Authentication is demo-grade.** The OTP is fixed at `123456` in every environment. `POST /auth/verify-credential-preauth` and `POST /auth/complete-signup` accept any `userId` without proof that its OTP was verified, and user ids can be inferred from public seller endpoints.
- **Authorisation checks are missing in places.** `POST /api/confirm` does not check that the transaction belongs to the caller; the chat API trusts a client-supplied `sessionId`; `PUT /auth/balance` lets a user set their own balance.
- **Maintenance endpoints are open.** `POST /api/db/reset`, `/api/demo/*`, `/api/settlement/*`, `DELETE /api/transactions` and `GET /api/diagnosis` have no authentication, and `/seller/debug-data` and `/seller/cds-test-publish` are available to any signed-in user. `devModeOnly` and `adminOnly` middleware exist in `packages/bap/src/middleware` but are not applied to them.
- **Beckn signatures are not verified.** Outgoing signing works when enabled, but incoming verification is never mounted (see `BECKN_VERIFY_SIGNATURES`).
- **Credential proofs are checked leniently.** An unresolvable issuer DID yields a warning rather than a failure, and the document is canonicalised with sorted-key JSON rather than URDNA2015, so nested claims are not covered by the hash.
- **The DISCOM, escrow and payments are simulated.**
- **WhatsApp uses [Baileys](https://github.com/WhiskeySockets/Baileys),** an unofficial WhatsApp Web client, which suits a demo only.

## Known issues

- **`npm ci` can fail on a git dependency.** `@whiskeysockets/baileys` 7.0.0-rc.9 pulls `libsignal` from a `git+ssh` URL. npm 12 refuses git dependencies by default (`EALLOWGIT`), and older npm needs SSH access to GitHub. Fix: set `"@whiskeysockets/baileys": "7.0.0-rc14"` in `packages/bap/package.json` and run `npm install`. That version installs from the registry and the project type-checks with it; the WhatsApp bot has not been retested on it.
- **Every backend test needs PostgreSQL and Redis.** The shared Jest setup connects to both for each file, including pure unit tests, so run `npm run setup` first. The ledger and trust-engine suites have fallen behind the code, and the route tests in `packages/bap/src/__tests__` exercise copies of the handlers rather than the real routers.
- **The root `start` scripts don't work.** They point at `dist/index.js` (tsc writes `dist/bap/src/index.js`) and use POSIX-only `NODE_ENV=…` syntax. Use the `dev` scripts locally.
- **The web Docker image doesn't build.** `.dockerignore` excludes `packages/web/src` for the API image and `output: 'standalone'` is commented out in `next.config.ts`, so `npm run docker:prod` fails at the web image. The API image builds.

## References

- [Beckn DEG](https://github.com/beckn/DEG): schemas, implementation guides and devkits for the energy network, including the [P2P trading guide](https://github.com/beckn/DEG/tree/p2p-trading/docs/implementation-guides/v2/P2P_Trading)
- [Beckn protocol specification v2](https://github.com/beckn/protocol-specifications-v2)
- [beckn-onix](https://github.com/beckn/beckn-onix), whose signature format `packages/shared/src/beckn/signing.ts` follows

## Notice

No licence is granted: this code is shared for portfolio viewing. © 2026 Aryan Jain, Emir Hurturk, Vivaan Gupta and Kuzey Korel. All rights reserved.

Not affiliated with Oorja Energy or any other company of that name. Oorja (ऊर्जा) is Hindi for "energy" and is only the chat agent's name.
