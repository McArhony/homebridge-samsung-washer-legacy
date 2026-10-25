# How the washer talks

Everything here was observed on a **WW10H9400EW** (it reports itself as `WW9000HE`) in October
2026, unless marked otherwise.

## The 2878 protocol (about 2013-2015)

- The washer only listens on **TCP 2878**: a full TCP scan shows nothing else, and it answers
  neither SSDP nor mDNS nor CoAP.
- **TLS 1.0 to 1.2** (TLS 1.2 / AES256-GCM-SHA384 negotiated). Washer certificate `CN=WM14K`,
  signed by `RemoteAccessCA(CE)` → `CECA` → `ROOTCA`, the same chain as Samsung's public
  **AC14K_M** certificate.
- **A client certificate is required** (otherwise a TLS "handshake failure" alert); AC14K_M is
  accepted. These certificates are SHA-1: OpenSSL 3 refuses them at its default security level
  (`SECLEVEL=0` needed); the SmartThings hub accepts them as they are.
- On connect the washer sends `DRC-1.00`, then `<Update Type="InvalidateAccount"/>`. Every
  message, both ways, is one line: `<?xml version="1.0" encoding="utf-8" ?><…/>` + `\r\n`.

### Token

`<Request Type="GetToken" />` → `<Response Type="GetToken" Status="Ready"/>`; then someone turns
**Smart Control off and on again** at the washer (short presses, starting with it on) → a few
seconds later `<Update Type="GetToken" Status="Completed" Token="…"/>` (36 characters, like a
UUID). Everything happens on the same connection: no callback.

### Session

1. `<Request Type="AuthToken"><User Token="…" /></Request>` → `Status="Okay"`.
2. `<Request Type="DeviceList" />` → `<Device DUID="…" GroupID="WM" ModelID="WM" />` (the DUID is
   the washer's MAC address without colons, followed by `0000`).
3. `<Request Type="DeviceState" DUID="…"></Request>` → a list of `<Attr ID="…" Type="R|W|RW" Value="…"/>`.

The washer also pushes `<Update Type="Status">` messages after every change.

### Commands

`<Request Type="DeviceControl"><Control CommandID="cmd…" DUID="…"><Attr ID="…" Value="…" /></Control></Request>`

- `WM_FUN_OPERATION`: `Start` (starts the selected programme, also resumes), `Pause`, `Stop`
  (cancels). **`Run` is refused** (ErrorCode 210).
- `WM_FUN_COURSE_OPTION`: programme and settings (below); never starts the washer.
- Answer: `<Response Type="DeviceControl" Status="Okay" CommandID="…"/>`. **Failures may come back
  without a `Type` attribute** (`<Response Status="Fail" ErrorCode="210" CommandID="…"/>`): match
  answers on `CommandID` too. "Okay" means accepted, not applied: read the state back.
- ErrorCode 210: refused value or state; 211: refused (Smart Control off, unknown attribute or
  format).

### Useful attributes

| Attribute | Meaning |
|---|---|
| `WM_FUN_OPERATION` | `Start`, `Pause`, `Stop` |
| `WM_FUN_PROGRESS` | phase: `Weightsensing`, `Wash`, … `Delaywash`; `NULL` when stopped |
| `WM_FUN_OTLEFT` | minutes left; when stopped, the length of the selected programme |
| `WM_FUN_COURSE` | programme name (e.g. `Cotton`) |
| `WM_FUN_COURSE_OPTION` | programme + settings, see below |
| `WM_FUN_OPT_LIST_INDOOR` | allowed settings of every programme |
| `WM_FUN_COURSE_LIST` | the programme codes, e.g. `3E/2F/2C/…` |
| `WM_FUN_SMARTCONTROL` | `On` / `Off` (read only) |
| `WM_FUN_CHILD_LOCK`, `WM_FUN_ERROR`, `WM_FUN_POWER` (read only) | |
| `WM_FUN_QUICK_WASH` | Express: 60/50/40/30/20/15/Off (read only) |
| `WM_FUN_EASY_IRON` | Easy iron (read only) |
| `WM_FUN_AUTO_DETERGENT`, `WM_FUN_AUTO_SOFTENER` | auto dispenser: `Enable` / `Disable` (`NotUsed` for some programmes); **writable**, checked |
| `WM_FUN_DETERGENT_INFO`, `WM_FUN_SOFTENER_INFO` | tank levels (`Normal` seen; other values not seen yet) |
| `WM_FUN_DISPENSER_OPEN`, `WM_FUN_DISPENSER_ABNORMAL` | drawer `Open` / `Close`; dispenser fault `On` / `Off` |
| `WM_FUN_DRUM_CLEAN`, `WM_FUN_FILTER_ALARM`, `WM_FUN_HOT_WARNING` | maintenance alerts, `On` / `Off` |
| `WM_FUN_CHILD_LOCK` | `Enable` / `Disable`; **writable**, checked |

The washer publishes 42 attributes in all; anything not in its `DeviceState` list (drum light,
intensive, pre-wash, soak…) is not available on the network.

A delayed end armed on the panel shows as `WM_FUN_OPERATION=Start` + `WM_FUN_PROGRESS=Delaywash`.

**Held start.** Once, a remote `Start` from `Stop` with Smart Control on was accepted (the
screen showed the programme as started, with Pause and Cancel) but the washer did not wash:
`WM_FUN_OPERATION=Start`, `WM_FUN_PROGRESS=NULL`, `WM_FUN_OTLEFT` frozen at the programme's
length, no error, for more than 25 minutes. Turning Smart Control off at the washer released it
at once (`WM_FUN_PROGRESS=Wash`). The same remote start had worked instantly the evening before
(another programme), and a remote resume after a pause with Smart Control on works instantly:
the condition is not understood yet. Washing always shows a phase; `Start` without a phase means
waiting.

**Changes during a cycle.** The washer accepts `WM_FUN_COURSE_OPTION` writes while running (the
rinse count was changed mid-cycle). The SmartThings driver refuses them, like the washer's own
screen does, until the cycle is cancelled.

`WM_FUN_OPERATION_PROGRESS` is the cycle's **progress in percent** (1 when stopped; e.g. 33 with
64 of about 95 minutes left). The light key of the washer changes no attribute at all.
**A full cycle** (Bedding, observed 25/10/2026): `Weightsensing` → `Wash` → `Rinse` → `Spin` →
`Finish`. `WM_FUN_OTLEFT` counts down minute by minute to 1 and `WM_FUN_OPERATION_PROGRESS`
reaches 100. At the end the washer keeps reporting `WM_FUN_OPERATION=Start` with
`WM_FUN_PROGRESS=Finish` (the driver treats it as stopped and finished), then leaves the Wi-Fi
about two minutes later.

### Programme and settings: `WM_FUN_COURSE_OPTION`

4 hex bytes: **programme**, `8t` **temperature**, `9r` **rinses**, `As` **spin**. For example
`2F8493A5` = Cotton, 40 °C, 3 rinses, 1400 rpm. Writing it (Smart Control on) changes programme
and settings without starting: `2C8392A4` → the screen shows Synthetics, 30°, 2 rinses, 1200.

- Temperature: `80` none, `81` cold, `82` 20, `83` 30, `84` 40, `85` 60, `86` 95 °C.
- Spin: `A0` rinse hold, `A1` no spin, `A2` 400, `A3` 800, `A4` 1200, `A5` 1400 rpm.
- Rinses: `90` to `95` = 0 to 5.

`WM_FUN_OPT_LIST_INDOOR` has 7 bytes per programme: code, default temperature, allowed
temperatures (bit *i* = index *i*), default rinses, allowed rinses, default spin, allowed spins.
For example Delicates allows 40 °C and 400 rpm at most; Eco Drum Clean is fixed at 60 °C / 400 rpm.

### Programmes of the WW10H9400EW

In screen order — machine name, code (French screen label):

`SmartWash` 3E (Lavage auto optimal) · `Cotton` 2F (Coton) · `Synthetics` 2C (Synthétiques) ·
`Denim` 30 (Jeans) · `DarkGarment` 31 (Couleurs) · `SuperSpeed` 47 (Super rapide) ·
`SuperEcoWash` 34 (Eco) · `OutdoorCare` 35 (Imperméable) · `BabyCare` 37 (Bébé coton) ·
`Wool` 11 (Laine) · `DelicatesWash` 48 (Délicats) · `Bedding1` 3A (Draps) · `Spin` 3B (Essorage) ·
`RinseSpin` 19 (Rinçage + essorage) · `EcoDrumClean` 33 (Nettoyage tambour) ·
`DiningKitchenwork` 1B (Cuisine) · `Gardening` 41 (Jardinage) · `HygieneCare` 43 (Soin hygiène
plus) · `ActiveSports` 42 (Sport) · `ActiveKids` 1E (Enfants actifs) · `DeskOffice` 1F
(Quotidien) · `CottonEco` 3F (e coton). The "favourite cycle" key has no code of its own.

### Not available remotely

- **Intensive, pre-wash, soak**: invisible (only the time changes) and not settable
  (`WM_FUN_COURSE_OPT_LIST` refuses "Intensive", "PreWash", "Soak", "B1" → 211).
- **Delayed end**: `WM_FUN_SETTIME="03:00"` is accepted but ignored (a Start after it ran a real
  wash).
- **Anything with Smart Control off**: every write is refused (211), even harmless ones. Tried
  without success: rewriting attributes to their current value, `WM_FUN_SMARTCONTROL=On`, a
  derived certificate imitating Samsung's servers (`samsung-washer cert --leaf`: connection and
  AuthToken accepted, write refused), invented attributes and request types. It is a firmware
  lock.
- **Power-on**: `WM_FUN_POWER` is read only and a switched-off washer leaves the Wi-Fi. With Smart
  Control on, it stays reachable (more than an hour observed).
- ⚠️ Holding Smart Control until "AP" puts the washer in Wi-Fi setup mode: it leaves the network,
  and without Samsung's old app nobody knows how to reconnect it.

## Samsung dryer codes (for the washer → dryer rule)

Observed on one SmartThings-native Samsung dryer, reference table `Table_03`, by setting each
code remotely and reading the screen: 16 Cotton · 1F Mixed Load · 1B Bedding · 1D Towels ·
19 Delicates · 18 Synthetics · 1E Outdoor (screen: sportswear) · 20 Iron Dry · 1A Wool ·
21 Hygiene Care (screen: anti-allergy) · 23 Quick Dry 35' · 27 Time Dry (not checked: 17, 1C,
22, 24, 25, 26).

`samsungce.dryerCycle.setDryerCycle` is refused without the dryer's remote control, but
**`custom.supportedOptions.setCourse("<code>")` works** without it, like the SmartThings app.

## The 8888 protocol (about 2016-2018)

Not used by the WW10H9400EW; implemented in `lib/client.js` from community documentation and
tested only against a simulated washer.

- HTTPS on TCP 8888, **TLS 1.0 only**, 1024-bit RSA server key → client `minVersion: 'TLSv1'`,
  `ciphers: 'DEFAULT:@SECLEVEL=0'`. Client certificate AC14K_M required (otherwise
  `400 No required SSL certificate was sent`).
- Malformed header `X-API-Version : v1.0.0` → hand-written tolerant HTTP parser.
- Token by callback: listen on **8889**, `POST /devicetoken/request` with `Host: <our-ip>:8889`,
  press Smart Control within about 63 s (child lock off); the washer posts
  `/devicetoken/response` with `{"DeviceToken":"…"}`.
- `GET /devices` (state, progress, remaining time "HH:MM:SS", programme `Course_XX`),
  `PUT /devices/0/operation {"Operation":{"state":"Run"|"Pause"|"Ready"}}` (204 = accepted, not
  applied), `403 SHE-001` = Smart Control off.
- A WW10H9600EW is known to answer on 8888, but its token never came back
  ([mbillow/localthings#635](https://github.com/mbillow/localthings/issues/635)).
