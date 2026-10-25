# SmartThings guide — step by step ✅

This guide installs the driver on **your own** SmartThings hub. No programming needed: you copy
a few commands. Count 30 to 45 minutes the first time.

At the end, your washer appears in the SmartThings app with its state, remaining time, start /
pause / cancel, its programme, temperature, spin and rinses, the auto dispenser (detergent and
softener on/off, tank levels, drawer), the child lock and maintenance alerts (drum clean, filter,
hot door, errors).

## What you need

- A washer that speaks the **2878 protocol** (about 2013-2015, e.g. WW10H9400EW), **already on
  your Wi-Fi**. These washers were put on the Wi-Fi with Samsung's old "Smart Washer" app; if
  yours never was, there is currently no known way to do it.
- A **SmartThings hub that runs Edge drivers**: SmartThings Hub v2 or v3, Aeotec Smart Home Hub
  (1 or 2), ThingsOne, or a recent Samsung TV with a built-in hub (this project runs on a 2025
  Frame TV). In the SmartThings app, your hub shows up as a device. Other "hub" devices
  (SmartThings Station, monitors, fridges) are not confirmed; see the
  [README](../README.md#which-smartthings-hub-do-i-need).
- A **computer** (Mac, Windows or Linux) on the same network as the washer, for the setup only.
- A **fixed IP address** for the washer is recommended: in your router's settings, look for
  "DHCP reservation" or "static lease" and reserve the washer's current address.

## 1. Install Node.js

Download the **LTS** version from [nodejs.org](https://nodejs.org) and install it like any app.

Then open a terminal:

- **Mac:** open the *Terminal* app (Applications → Utilities).
- **Windows:** open *PowerShell* (Start menu → type "PowerShell").

Check it works — this should print a version number like `v24.x.x`:

```sh
node -v
```

## 2. Download this project

On the project's GitHub page, click the green **Code** button → **Download ZIP**, then unzip it
(for example in your *Downloads* folder). In the terminal, go into that folder:

```sh
cd ~/Downloads/smartthings-samsung-drc-washer-main
```

(On Windows: `cd $HOME\Downloads\smartthings-samsung-drc-washer-main`. If the folder name is
different, type `cd ` and drag the folder onto the terminal window.)

## 3. Put the Samsung certificate in the driver

The washer only talks to clients that present Samsung's public "AC14K_M" certificate. This
command downloads it into the driver's folder:

```sh
node bin/cli.js cert --dir smartthings-edge/src/secrets
```

It creates `ac14k_m.pem` and `ac14k_m.key` in `smartthings-edge/src/secrets/`. They are packaged
with **your** copy of the driver, which only you can install. Do not publish them.

## 4. Find and test the washer

Switch the washer on and press **Smart Control** (its light turns on). Then:

```sh
node bin/cli.js find
```

It lists the devices answering on the washers' ports. **Other devices can show up too** (some
smart speakers or thermostats use port 8888). Test each address it found, for example:

```sh
node bin/cli.js test 192.168.1.50 --dir smartthings-edge/src/secrets
```

You are looking for this line, which means it is your washer and it speaks the right protocol:

```
3) Connecting with the Samsung certificate (ca) …
   ✓ certificate accepted (DRC-1.00), the washer asks for a token
```

Note the washer's address: it helps if something goes wrong, but the driver finds the washer
by itself.

## 5. Install the SmartThings command line tool and sign in

```sh
npm install -g @smartthings/cli
smartthings locations
```

The second command opens your browser: sign in with your Samsung account and accept. The
terminal then lists your SmartThings locations.

## 6. Create your driver channel

A channel is your private "shop" of drivers. Create one (answer the questions; any web address
works for the terms of service, for example this project's page):

```sh
smartthings edge:channels:create
```

## 7. Send the driver to your hub

```sh
smartthings edge:drivers:package smartthings-edge --install
```

Choose your channel, then your hub, when asked. It ends with "Installed driver … to hub …".
If it complains that the hub is not enrolled, run `smartthings edge:channels:enroll`, pick the
channel and the hub, then repeat the command above.

> The driver uses ready-made capabilities (programme, temperature, spin, rinses, remaining
> time) published by this project in the `perfectforest07855` namespace, so you do not have to
> create them. If packaging ever refuses them, see "Using your own capabilities" in
> [smartthings-edge/README.md](../smartthings-edge/README.md).

## 8. Add the washer in the app

The washer must be on, with Smart Control on. In the SmartThings app:
**+** → **Add device** → **Scan nearby** (or *Scan for nearby devices*).

The driver looks for the washer on your network; after up to a minute, a **"Washer"** device
appears. It shows as offline until you pair it.

## 9. Pair (once)

1. Stand in front of the washer, child lock off, door closed, **Smart Control on**.
2. In the app, open the washer → **⋮** → **Settings** → turn on **"Pair now"**.
3. Within 3 minutes, press **Smart Control** briefly (it turns off), wait 2-3 seconds, press it
   again (it turns back on).

A few seconds later the washer comes online and shows its state. (You can turn "Pair now" back
off.) If nothing happens, turn "Pair now" off and on again and repeat.

## Choose what the screen shows

In the washer's **⋮ → Settings**, tick what you want to see between the controls and the
programme (nothing by default):

- **Show progress**: "Rinse · 85% · 15 min";
- **Show status**: "All OK", or what needs attention ("Detergent tank low", "Clean the filter"…);
- **Show Smart Control**.

The tile always shows the phase and progress ("Rinse · 85%"). Close and reopen the app to see a
change. Everything hidden stays available in routines and automations.

The **auto dispenser** (detergent and softener) is also in the settings. A change is applied as soon
as the washer is stopped with Smart Control on (otherwise it waits). Settings only go from the app
to the washer: a change made on the washer's screen does not update them.

## Every day

1. Load the laundry, close the door, press **Smart Control**.
2. In SmartThings, choose the programme, temperature, spin and rinses, then start — even away
   from home.

With Smart Control off, the washer is still shown but refuses changes. During a cycle, like on
the washer itself, the programme, settings and auto dispenser are locked (cancel the cycle to
change them); the child lock stays available. While the washer is off, it shows "Off", offers no
action and refuses every change. After a full cycle, the washer shows "finished"
until the next wash.

## Optional: link with a Samsung dryer

If your Samsung dryer is in SmartThings too, a rule can imitate Samsung's "Auto Cycle Link":
when you switch the dryer on after a wash, it gets the matching drying programme (it never starts
it). See "Washer → dryer link" in [smartthings-edge/README.md](../smartthings-edge/README.md);
the dryer programme codes there come from one dryer model and may differ on yours.

## Updating the driver

Download the new version, put your `src/secrets/` folder back in it, then repeat step 7. Your
device and its settings are kept.

## Troubleshooting

| Problem | What to try |
|---|---|
| `find` finds nothing | Washer off, Smart Control off, or computer on another network (guest Wi-Fi, 5 GHz-only network isolated from 2.4 GHz…) |
| `test`: port closed | Wrong address, or the washer left the Wi-Fi (switch it on, Smart Control on) |
| `test` answers on 8888 but not 2878 | Newer washer (2016-2018): not supported by the SmartThings driver yet |
| "Scan nearby" finds nothing | Washer off or Smart Control off; hub and washer on different networks; try again after a minute |
| Washer shows "Off" | Normal when it is switched off: these washers leave the Wi-Fi a few minutes after a cycle. If it is on with Smart Control on, its address may have changed: the driver looks for it again (at most every 30 minutes), or type its address in the device settings |
| "Can't connect to device" | The device is offline: the token was refused — turn on "Pair now" and pair again |
| Pairing does nothing | Smart Control must go **off then on** while "Pair now" is active; child lock off; door closed |
| Changes refused | Smart Control is off at the washer |
| Programme names look wrong | Your model has other programmes: open an issue with `node bin/cli.js status <ip> --raw` |
| See what the driver does | `smartthings edge:drivers:logcat` (choose the driver; accept the hub's certificate once) |
