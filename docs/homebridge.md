# Homebridge plugin 🚧 work in progress

The repository is also a Homebridge plugin, `SamsungWasherLegacy`. It shows the washer in
Apple Home as:

- a **valve "Washer"**: on = start the programme selected on the washer (or resume), off =
  pause (or cancel, in the settings); it shows the remaining time;
- a **contact sensor "Washer finished"** that opens at the end of a cycle, so Apple Home can
  notify you.

Apple Home has no washer type, hence the valve. The SmartThings driver goes much further
(programmes, settings, translations): **prefer it if you have a SmartThings hub**.

## Status

| | |
|---|---|
| Reading state and remaining time (2878, WW10H9400EW) | ✅ checked |
| Start, pause, resume from Apple Home (2878) | ✅ checked |
| A delayed start is not shown as running | ✅ |
| "Finished" sensor on a real end of cycle | ⚠️ never observed yet |
| Programme, temperature, spin, rinses | ❌ not in the plugin (Apple Home cannot show them) |
| 8888 protocol (2016-2018 washers) | ⚠️ written from community documentation, tested only against a simulated washer |
| Published on npm | ❌ install from GitHub |

Bug reports and help are welcome.

## Install

On your Homebridge server, in a terminal (Homebridge UI: **⋮ → Terminal**):

```sh
cd /var/lib/homebridge      # Homebridge folder (Mac: cd ~/.homebridge)
npm install --save github:McArhony/smartthings-samsung-drc-washer
```

Restart Homebridge.

## Set up (once)

Replace `192.168.1.50` with your washer's address (`npx samsung-washer find` lists candidates).

1. Samsung's public certificate: `npx samsung-washer cert`
2. Test, read only — washer on, Smart Control on: `npx samsung-washer test 192.168.1.50`
3. Pairing — in front of the washer, child lock off, door closed:
   `npx samsung-washer pair 192.168.1.50`
   - **2878 washers:** start with Smart Control **on**; as soon as "request sent" shows, press
     Smart Control briefly (it turns off), wait 2-3 s, press it again.
   - **8888 washers:** start with Smart Control **off**; as soon as "window open" shows, press
     Smart Control to turn it on. In Docker, Homebridge needs the `host` network (the washer
     calls back on port 8889).
4. Check: `npx samsung-washer status 192.168.1.50`
5. Homebridge UI → **Plugins → Samsung Washer Legacy → Settings**: name and IP, save, restart.

> ⚠️ **Never hold Smart Control until "AP" shows**: the washer would leave your Wi-Fi.

## Every day

Smart Control has to be on at the washer for Apple Home to start or pause it (and it locks the
washer's screen while on). Without it, the washer leaves the Wi-Fi a few minutes after stopping
and simply shows as off.

## Troubleshooting

| Symptom | Lead |
|---|---|
| `test`: port closed | Wrong IP, washer off, or Smart Control off (it tries 2878 then 8888) |
| `pair` (2878): no token | Smart Control off **then** on while a request is pending; child lock; door closed |
| `pair` (8888): no callback | Press during an open window, firewall on port 8889, Docker without `host` network |
| `pair`: still nothing | `npx samsung-washer cert --leaf` (derived certificate, needs `openssl`), then pair again |
| Apple Home: "No response" when starting | Smart Control off, or the washer refused the command (see the Homebridge log) |
