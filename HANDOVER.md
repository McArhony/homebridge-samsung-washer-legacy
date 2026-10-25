# Handover — project status and next steps

For contributors (and AI assistants) picking the project up. User-facing documentation:
[README](README.md), [SmartThings guide](docs/smartthings.md), [Homebridge](docs/homebridge.md),
[protocol notes](docs/protocol.md).

**This repository is public: never commit tokens, keys, certificates, device or location IDs,
home IP addresses or account details.** Secrets go in `smartthings-edge/src/secrets/`, which is
git-ignored.

## Status (October 2026)

| Part | Status |
|---|---|
| 2878 protocol | ✅ decoded on a WW10H9400EW: state, commands, programmes, settings ([docs/protocol.md](docs/protocol.md)) |
| SmartThings Edge driver | ✅ in daily use: state, phase, remaining time, start/pause/cancel, programme, temperature, spin, rinses, 5 languages |
| Driver discovery | 🧪 new: finds the washer on the hub's /24 network on port 2878, no address to type; to be confirmed on a real install |
| In-app pairing ("Pair now") | 🧪 written, not yet used on a real washer (the first token came from `samsung-washer pair`) |
| Washer → dryer rule | 🧪 created on one install; not yet seen on a real end of cycle |
| Homebridge plugin | 🚧 state and start/pause checked on 2878; "finished" sensor never observed; 8888 only simulated |
| `samsung-washer` tool | ✅ `find`, `cert`, `test`, `pair`, `status`, `start`, `pause`, `cancel` |
| Tests | Node: `npm test` (simulated 2878 and 8888 washers). Lua: `lua smartthings-edge/test/test_drc.lua && lua smartthings-edge/test/test_course.lua` |

## Layout

| Path | Role |
|---|---|
| `smartthings-edge/` | SmartThings Edge driver (Lua), capabilities generator, dryer rule generator — see its [README](smartthings-edge/README.md) |
| `lib/drc.js` | 2878 protocol in Node.js (`DrcSession`, `DrcWasher`) |
| `lib/client.js`, `lib/pairing.js` | 8888 protocol in Node.js |
| `lib/connect.js` | protocol detection (2878 then 8888) |
| `lib/store.js` | certificate / token folder, derived ("leaf") certificate |
| `bin/cli.js` | the `samsung-washer` command line tool |
| `index.js`, `config.schema.json` | Homebridge accessory and its settings form |
| `test/` | fake 2878 and 8888 washers + `node --test` |

## Next steps

1. **Watch a full wash** on the SmartThings driver: remaining time going down, final phase name,
   "finished", then the dryer rule.
2. **Confirm discovery and in-app pairing** on a fresh install (follow the guide from scratch).
3. **One-click install for everyone**: a public SmartThings channel with an invite link, so users
   skip the command line steps. It requires shipping Samsung's AC14K_M certificate and key inside
   the driver package (a hub cannot download files): they have been public for years, but belong
   to Samsung — the owner's decision.
4. **Other models**: programmes of other 2878 washers are unknown (the driver would show only
   known ones); the 8888 protocol in the driver; collect `status --raw` outputs from users.
5. Homebridge: observe the "finished" sensor on a real cycle; publish on npm if there is demand.
6. Optional: decode the dryer codes not checked yet; show Express / Easy iron as read-only states.

## Pitfalls already met

- Failure answers without `Type` (match on `CommandID`), `Run` refused (use `Start`).
- Samsung's `custom.*` capabilities are not shown by the SmartThings app for third-party
  drivers: the driver uses its own capabilities (`perfectforest07855` namespace).
- `@smartthings/cli` 2.1.2: several error paths crash with "Cannot use 'in' operator …
  isAxiosError" and hide the real error (`edge:channels:enroll` for one); the driver installs
  anyway.
- OpenSSL 3 refuses the SHA-1 Samsung certificates by default (local tests use
  `smartthings-edge/tools/openssl-seclevel0.cnf`).
- Smart Control locks the washer's touch screen; with it off, every write is refused.
