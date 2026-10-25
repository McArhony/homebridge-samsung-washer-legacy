#!/usr/bin/env python3
"""Generates the device presentations (capabilities/device-config-<variant>.json)
and the matching profiles (profiles/samsung-washer-drc*.yml).

The iOS app always shows read-only values in a card between the grey control
card and the settings. Three check boxes of the device (show progress, status,
Smart Control) pick one of these 8 variants; the driver then switches the
device to its profile.

  python3 capabilities/build_profiles.py            # writes the device configs
  # create each config: smartthings presentation:device-config:create -i capabilities/device-config-<variant>.json
  # put the returned vids in capabilities/vids.json, then:
  python3 capabilities/build_profiles.py            # also writes the profiles
"""
import json
import os

NS = "perfectforest07855"
HERE = os.path.dirname(os.path.abspath(__file__))
PROFILES_DIR = os.path.join(HERE, "..", "profiles")

# Check boxes: (letter in the variant name, block shown when checked)
BLOCKS = [("p", NS + ".washerCycle"), ("s", NS + ".washerStatus"), ("r", NS + ".washerSmartControl")]


def variants():
    """variant key ("" or a combination of p, s, r) → (profile name, blocks)."""
    out = {}
    for mask in range(8):
        key = "".join(letter for i, (letter, _) in enumerate(BLOCKS) if mask >> i & 1)
        blocks = [cap for i, (_, cap) in enumerate(BLOCKS) if mask >> i & 1]
        out[key] = ("samsung-washer-drc" + (f"-{key}" if key else ""), blocks)
    return out


VARIANTS = variants()

# The auto dispenser is set in the device settings (preferences), not on the screen.
SETTINGS = [NS + ".washerProgramme", NS + ".washerTemperature", NS + ".washerSpin", NS + ".washerRinse",
            NS + ".washerChildLock", "refresh"]

# Every variant has every capability: only the screen differs.
CAPABILITIES = ["washerOperatingState", NS + ".washerCycle", NS + ".washerControl", NS + ".washerRemainingTime",
                NS + ".washerProgramme", NS + ".washerTemperature", NS + ".washerSpin", NS + ".washerRinse",
                NS + ".washerStatus", NS + ".washerSmartControl", "remoteControlStatus", NS + ".washerChildLock", NS + ".washerDispenser",
                NS + ".washerAlerts", "refresh"]

AUTOMATION_CONDITIONS = ["washerOperatingState", NS + ".washerCycle", NS + ".washerRemainingTime", NS + ".washerStatus",
                         NS + ".washerProgramme", NS + ".washerTemperature", NS + ".washerSpin", NS + ".washerRinse",
                         NS + ".washerSmartControl", "remoteControlStatus", NS + ".washerChildLock", NS + ".washerDispenser",
                         NS + ".washerAlerts"]
AUTOMATION_ACTIONS = [NS + ".washerControl", "washerOperatingState", NS + ".washerProgramme", NS + ".washerTemperature",
                      NS + ".washerSpin", NS + ".washerRinse", NS + ".washerChildLock", NS + ".washerDispenser"]

PREFERENCES = '''preferences:
  - name: showProgress
    title: "Show progress"
    description: "Phase, progress and minutes left, above the programme"
    required: false
    preferenceType: boolean
    definition:
      default: false
  - name: showStatus
    title: "Show status"
    description: "What needs attention (tanks, filter, drum clean, errors)"
    required: false
    preferenceType: boolean
    definition:
      default: false
  - name: showSmartControl
    title: "Show Smart Control"
    required: false
    preferenceType: boolean
    definition:
      default: false
  - name: autoDetergent
    title: "Auto detergent"
    description: "Applied when the washer is stopped with Smart Control on"
    required: false
    preferenceType: boolean
    definition:
      default: false
  - name: autoSoftener
    title: "Auto softener"
    description: "Applied when the washer is stopped with Smart Control on"
    required: false
    preferenceType: boolean
    definition:
      default: false
  - name: ipAddress
    title: "Washer IP address (optional)"
    description: "Leave empty: the washer is found automatically"
    required: false
    preferenceType: string
    definition:
      stringType: text
  - name: pollSeconds
    title: "Polling interval (s)"
    required: false
    preferenceType: integer
    definition:
      minimum: 10
      maximum: 600
      default: 30
  - name: pairNow
    title: "Pair now"
    description: "Turn on, then turn Smart Control off and on again at the washer within 3 minutes"
    required: false
    preferenceType: boolean
    definition:
      default: false
'''


def item(cap, **extra):
    d = {"component": "main", "capability": cap, "version": 1, "values": [], "patch": []}
    d.update(extra)
    return d


def device_config(info):
    return {
        "type": "profile",
        "dashboard": {"states": [item(NS + ".washerRemainingTime", idx=0, group="main", composite=False)],
                      "actions": [], "basicPlus": []},
        "detailView": [item(c) for c in ["washerOperatingState"] + info + SETTINGS],
        "automation": {"conditions": [item(c, exclusion=[]) for c in AUTOMATION_CONDITIONS],
                       "actions": [item(c, exclusion=[]) for c in AUTOMATION_ACTIONS]},
    }


def profile(name, vid):
    caps = "".join(f"      - id: {c}\n        version: 1\n" for c in CAPABILITIES)
    return (f"# Generated by capabilities/build_profiles.py — do not edit by hand.\n"
            f"name: {name}\ncomponents:\n  - id: main\n    capabilities:\n{caps}"
            f"    categories:\n      - name: Washer\n"
            f"metadata:\n  ocfDeviceType: oic.d.washer\n  vid: {vid}\n  mnmn: SmartThingsCommunity\n"
            + PREFERENCES)


def main():
    vids_file = os.path.join(HERE, "vids.json")
    vids = json.load(open(vids_file)) if os.path.exists(vids_file) else {}
    for variant, (name, info) in VARIANTS.items():
        with open(os.path.join(HERE, f"device-config-{variant or 'none'}.json"), "w", encoding="utf-8") as f:
            json.dump(device_config(info), f, indent=2)
        if (variant or "none") in vids:
            with open(os.path.join(PROFILES_DIR, f"{name}.yml"), "w", encoding="utf-8") as f:
                f.write(profile(name, vids[variant or "none"]))
    missing = [v or "none" for v in VARIANTS if (v or "none") not in vids]
    print("device configs written" + (f"; vids missing for: {', '.join(missing)}" if missing else "; profiles written"))


if __name__ == "__main__":
    main()
