# Samsung legacy washers in SmartThings (and Homebridge)

Bring back remote control of old Samsung **"Smart Control"** Wi-Fi washers that SmartThings
does not support — for example the **WW10H9400EW Crystal Blue** (2014) — **locally**, without
Samsung's cloud.

## Choose your option

| | **SmartThings** ✅ | **Homebridge** 🚧 |
|---|---|---|
| Status | **Working**, used every day on a WW10H9400EW | **Work in progress** |
| Runs on | your SmartThings hub (dedicated hub or built into a recent Samsung TV) | a Homebridge server (Raspberry Pi, Mac, NAS…) |
| App | SmartThings | Apple Home |
| State, phase, remaining time, end of cycle | ✅ | ✅ state and remaining time; end-of-cycle sensor not checked on a real wash |
| Start, pause, resume, cancel | ✅ | ✅ start / pause (or cancel) |
| Programme, temperature, spin, rinses | ✅ | ❌ |
| Languages | English, French, German, Spanish, Italian | English |
| Guide | **[docs/smartthings.md](docs/smartthings.md)** | [docs/homebridge.md](docs/homebridge.md) |

Both use the same small command line tool, `samsung-washer` (in this repository), to find and
test the washer.

## Is my washer supported?

These washers expose an undocumented local protocol. Two generations exist:

| Port | Format | Washers | SmartThings driver | Homebridge plugin |
|---|---|---|---|---|
| **2878** | XML over TLS ("DRC-1.00") | about 2013-2015, e.g. **WW10H9400EW** | ✅ | 🚧 |
| **8888** | JSON over HTTPS | about 2016-2018 | ❌ not yet | 🚧 untested on a real washer |

The quickest way to know: put the washer on your Wi-Fi with Smart Control on, then run
`samsung-washer find` and `samsung-washer test <ip>` (see the guides). It only reads, it
changes nothing on the washer.

Only the **WW10H9400EW** has been checked. Other models of the same generation should work, but
their programme list will differ: please open an issue with the output of
`samsung-washer status <ip> --raw`.

## Good to know

- Samsung requires **Smart Control to be on** at the washer for anything done remotely; it also
  locks the washer's touch screen while on. With Smart Control off, the washer can still be
  watched but refuses every change. A switched-off washer leaves the Wi-Fi and cannot be powered
  on remotely.
- ⚠️ **Never hold the Smart Control button until "AP" shows**: the washer would leave your Wi-Fi,
  and without Samsung's old app you may not be able to reconnect it.
- Not available remotely: intensive, pre-wash and soak options, delayed end; Express and Easy iron
  are read only.

## More

- [docs/protocol.md](docs/protocol.md): how the washer talks, programme and settings codes.
- [HANDOVER.md](HANDOVER.md): project status and next steps, for contributors.
- [CONTRIBUTING.md](CONTRIBUTING.md): how to help — reporting your washer model is the most useful.
- `smartthings-edge/`: the SmartThings driver ([developer notes](smartthings-edge/README.md)).
- `index.js`, `lib/`, `bin/`: the Homebridge plugin and the `samsung-washer` tool (Node.js, no
  dependencies).

## Credits

2878 protocol read on the washer, after the protocol of Samsung's "AC14K" air conditioners.
8888 protocol documented by
[perseus177/ha-samsung-washer-local](https://github.com/perseus177/ha-samsung-washer-local)
and
[johnnyvontruant/HASS-Samsung-Dongle-Local](https://github.com/johnnyvontruant/HASS-Samsung-Dongle-Local).
Samsung's public AC14K_M certificate is downloaded from
[brayStorm/samsung-appliance-token](https://github.com/brayStorm/samsung-appliance-token);
it is not included in this repository.

Unofficial project, not affiliated with Samsung. MIT licence.
