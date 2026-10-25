#!/usr/bin/env python3
"""SmartThings rule imitating Samsung's "Auto Cycle Link": when the dryer is
switched on after the washer finished a full cycle, the dryer gets the drying
programme matching the washing one (never started).

  python3 rules/build_auto_cycle_link.py <washer-device-id> <dryer-device-id> > rule.json
  smartthings rules:create -i rule.json --location <location-id>

Dryer codes: Samsung dryer with referenceTable "Table_03", read on 24/10/2026
(custom.supportedOptions.setCourse, accepted without remote control).
"""
import json
import sys

NS = "perfectforest07855"

DRYER = {  # code: name in the SmartThings app (label on the French dryer screen)
    "16": "Cotton (Coton)", "1F": "Mixed Load (Mix)", "1B": "Bedding (Draps)",
    "1D": "Towels (Serviettes)", "19": "Delicates (Délicat)", "18": "Synthetics (Synthétiques)",
    "1E": "Outdoor (Vêtements de sport)", "20": "Iron Dry (Prêt à repasser)", "1A": "Wool (Laine)",
    "21": "Hygiene Care (Anti-allergènes)", "23": "Quick Dry 35' (Séchage rapide 35')",
    "27": "Time Dry (Séchage minuté)",
}

# Dryer code → washer programmes (washerProgramme values). Programmes not
# listed (Spin, RinseSpin, EcoDrumClean) leave the dryer as it is.
MAPPING = {
    "16": ["Cotton", "CottonEco", "BabyCare", "Denim", "Gardening"],
    "1F": ["SmartWash", "DarkGarment", "SuperEcoWash", "DeskOffice", "ActiveKids"],
    "18": ["Synthetics"],
    "19": ["DelicatesWash"],
    "1A": ["Wool"],
    "1B": ["Bedding1"],
    "1D": ["DiningKitchenwork", "HygieneCare"],
    "1E": ["ActiveSports", "OutdoorCare"],
    "23": ["SuperSpeed"],
}


def washer(capability, attribute, washer_id):
    # Read only when the rule runs: washer changes must not trigger it.
    return {"device": {"devices": [washer_id], "component": "main", "capability": capability,
                       "attribute": attribute, "trigger": "Never"}}


def build(washer_id, dryer_id):
    branches = []
    for code, programmes in MAPPING.items():
        tests = [{"equals": {"left": washer(f"{NS}.washerProgramme", "programme", washer_id),
                             "right": {"string": p}}} for p in programmes]
        condition = {"or": tests} if len(tests) > 1 else tests[0]
        set_course = {"command": {"devices": [dryer_id], "commands": [{
            "component": "main", "capability": "custom.supportedOptions", "command": "setCourse",
            "arguments": [{"string": code}]}]}}
        branches.append({"if": {**condition, "then": [set_course]}})

    washer_finished = {"equals": {"left": washer("washerOperatingState", "washerJobState", washer_id),
                                  "right": {"string": "finish"}}}
    # Give the dryer a moment after power-on before changing its programme.
    pause = {"sleep": {"duration": {"value": {"integer": 5}, "unit": "Second"}}}
    dryer_switched_on = {"equals": {
        "left": {"device": {"devices": [dryer_id], "component": "main", "capability": "switch", "attribute": "switch"}},
        "right": {"string": "on"}, "changesOnly": True}}

    return {
        "name": "Washer → dryer (Auto Cycle Link)",
        "actions": [{"if": {**dryer_switched_on, "then": [
            {"if": {**washer_finished, "then": [pause, *branches]}},
        ]}}],
    }


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    json.dump(build(sys.argv[1], sys.argv[2]), sys.stdout, indent=2, ensure_ascii=False)
