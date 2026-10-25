# SmartThings Edge driver — developer notes

LAN driver for a SmartThings hub. It talks **directly** to the washer (XML over TLS on port
2878, see [docs/protocol.md](../docs/protocol.md)). To install it, follow the
[step-by-step guide](../docs/smartthings.md).

## Files

| Path | Role |
|---|---|
| `src/drc.lua` | protocol: session, AuthToken, DeviceState, DeviceControl, pairing |
| `src/discovery.lua` | finds the washer: every address of the hub's /24 on port 2878, then a TLS check (`InvalidateAccount` greeting) |
| `src/course.lua` | programmes and settings of the WW10H9400EW, `WM_FUN_COURSE_OPTION` encoding |
| `src/init.lua` | the SmartThings device |
| `src/secrets/` | **git-ignored**: `ac14k_m.pem`, `ac14k_m.key` (`samsung-washer cert --dir src/secrets`), optional `token.lua` (`return "<token>"`) |
| `profiles/samsung-washer-drc.yml` | capabilities and settings (optional IP address, polling interval, "Pair now") |
| `capabilities/build.py` | generates the custom capabilities, presentations and translations into `capabilities/out/` (single-value ones in `CAPABILITIES`, multi-attribute ones in `MULTI`) |
| `capabilities/device-config.json` | device presentation: state and remaining time on the tile, no button |
| `rules/build_auto_cycle_link.py` | optional washer → dryer rule |
| `test/` | `lua test/test_drc.lua && lua test/test_course.lua` |
| `tools/live_read.lua` | real read from a computer (luasocket + luasec): `OPENSSL_CONF=tools/openssl-seclevel0.cnf lua tools/live_read.lua <ip> <secrets-folder>` |

## Device

- `washerOperatingState`: start / pause / stop, phase (`weightSensing`, `wash`, `rinse`, `spin`,
  `delayWash`, `finish`…), completion time. After a full cycle (a stop with ≤ 5 minutes left),
  `finish` stays until the next start.
- `remoteControlStatus`: Smart Control on / off. `refresh`.
- Custom capabilities, namespace `perfectforest07855`, translated (English default, French,
  German, Spanish, Italian): `washerProgramme`, `washerTemperature`, `washerSpin`, `washerRinse`
  (only the values the selected programme allows) and `washerRemainingTime` (read only, "1:23",
  on the tile), `washerDispenser` (auto detergent / softener on-off, tank levels, drawer),
  `washerAlerts` (drum clean, filter, hot door, dispenser fault, error code) and
  `washerChildLock`. Samsung's own `custom.washer*` capabilities exist, but the app does not show
  them for a third-party driver.
- The washer is found automatically (discovery, then again after 10 failed polls if its address
  changed), unless an address is typed in the settings. Token: `secrets/token.lua` if present,
  otherwise "Pair now" in the settings.

## Build and install

```sh
smartthings edge:drivers:package smartthings-edge --install            # asks for channel and hub
smartthings edge:drivers:package smartthings-edge --channel <channel-id> --hub <hub-id>
smartthings edge:drivers:logcat                                         # live logs
```

## Using your own capabilities

The profile and `capabilities/device-config.json` use the project's `perfectforest07855`
namespace. To use your own instead:

```sh
python3 capabilities/build.py <your-namespace>      # writes capabilities/out/
# for each capability: washerProgramme, washerTemperature, washerSpin, washerRinse, washerRemainingTime,
#   washerDispenser, washerAlerts, washerChildLock
smartthings capabilities:create -i capabilities/out/<cap>.json          # first one creates your namespace
smartthings capabilities:presentation:create -i capabilities/out/<cap>.presentation.json <ns>.<cap>
smartthings capabilities:translations:upsert <ns>.<cap> -i capabilities/out/<cap>.<lang>.json   # en fr de es it
```

Then replace `perfectforest07855` in `profiles/samsung-washer-drc.yml`, `src/init.lua` and
`capabilities/device-config.json`, create the presentation with
`smartthings presentation:device-config:create -i capabilities/device-config.json` and put the
returned `vid` in the profile's `metadata`.

## Washer → dryer link (imitating Samsung's "Auto Cycle Link")

`rules/build_auto_cycle_link.py` builds a SmartThings rule: when a Samsung dryer is switched on
while the washer shows `finish`, the dryer gets the matching drying programme
(`custom.supportedOptions.setCourse`, accepted without the dryer's remote control; it never starts
the dryer). The dryer codes (reference table `Table_03`) and the washer → dryer mapping are at the
top of the script; check them against your dryer ([docs/protocol.md](../docs/protocol.md)).

```sh
smartthings devices                      # note the washer's and the dryer's device IDs
smartthings locations                    # note your location ID
python3 rules/build_auto_cycle_link.py <washer-id> <dryer-id> > rule.json
smartthings rules:create -i rule.json --location <location-id>
```

Limit: while the washer stays `finish`, every dryer power-on applies the programme again.
