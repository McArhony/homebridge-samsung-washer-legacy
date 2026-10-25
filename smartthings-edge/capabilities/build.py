#!/usr/bin/env python3
"""Generates the custom capabilities of the driver, their presentations and
translations (capabilities/out/), from the tables below.

  python3 capabilities/build.py <namespace>

then, for each capability (see README.md):
  smartthings capabilities:create -n <ns> -i out/<cap>.json            (first time)
  smartthings capabilities:presentation:create|update -i out/<cap>.presentation.json <ns>.<cap>
  smartthings capabilities:translations:upsert <ns>.<cap> -i out/<cap>.<lang>.json

Values are neutral keys (what the machine or the driver uses); every label
shown in the app comes from a translation, English being the default.
English and French are checked; German, Spanish and Italian are best effort.
"""
import json
import os
import sys

LANGS = ["en", "fr", "de", "es", "it"]

# Machine names (WM_FUN_COURSE) of the WW10H9400EW, in the order of its screen.
PROGRAMMES = [
    ("SmartWash", "Smart Wash", "Lavage auto optimal", "Smart Wash", "Lavado inteligente", "Lavaggio smart"),
    ("Cotton", "Cotton", "Coton", "Baumwolle", "Algodón", "Cotone"),
    ("Synthetics", "Synthetics", "Synthétiques", "Pflegeleicht", "Sintéticos", "Sintetici"),
    ("Denim", "Denim", "Jeans", "Jeans", "Vaqueros", "Jeans"),
    ("DarkGarment", "Dark Garment", "Couleurs", "Dunkle Wäsche", "Ropa oscura", "Capi scuri"),
    ("SuperSpeed", "Super Speed", "Super rapide", "Super Speed", "Súper rápido", "Super rapido"),
    ("SuperEcoWash", "Eco", "Eco", "Eco", "Eco", "Eco"),
    ("OutdoorCare", "Outdoor Care", "Imperméable", "Outdoor", "Ropa exterior", "Capi impermeabili"),
    ("BabyCare", "Baby Care", "Bébé coton", "Babypflege", "Bebé", "Neonati"),
    ("Wool", "Wool", "Laine", "Wolle", "Lana", "Lana"),
    ("DelicatesWash", "Delicates", "Délicats", "Feinwäsche", "Delicados", "Delicati"),
    ("Bedding1", "Bedding", "Draps", "Bettwäsche", "Ropa de cama", "Lenzuola"),
    ("Spin", "Spin", "Essorage", "Schleudern", "Centrifugado", "Centrifuga"),
    ("RinseSpin", "Rinse + Spin", "Rinçage + essorage", "Spülen + Schleudern", "Aclarado + centrifugado", "Risciacquo + centrifuga"),
    ("EcoDrumClean", "Eco Drum Clean", "Nettoyage tambour", "Trommelreinigung", "Limpieza del tambor", "Pulizia cestello"),
    ("DiningKitchenwork", "Kitchen", "Cuisine", "Küche", "Cocina", "Cucina"),
    ("Gardening", "Gardening", "Jardinage", "Garten", "Jardinería", "Giardinaggio"),
    ("HygieneCare", "Hygiene Care+", "Soin hygiène plus", "Hygiene+", "Higiene+", "Igiene+"),
    ("ActiveSports", "Sports", "Sport", "Sport", "Deporte", "Sport"),
    ("ActiveKids", "Active Kids", "Enfants actifs", "Kinder", "Niños activos", "Bambini"),
    ("DeskOffice", "Daily Wash", "Quotidien", "Täglich", "Diario", "Quotidiano"),
    ("CottonEco", "e-Cotton", "e coton", "e-Baumwolle", "e-Algodón", "e-Cotone"),
]

TEMPERATURES = [
    ("none", "None", "Aucune", "Keine", "Ninguna", "Nessuna"),
    ("cold", "Cold", "Froid", "Kalt", "Frío", "Freddo"),
] + [(t, f"{t} °C", f"{t} °C", f"{t} °C", f"{t} °C", f"{t} °C") for t in ("20", "30", "40", "60", "95")]

SPINS = [
    ("rinseHold", "Rinse hold", "Rinçage en attente", "Spülstopp", "Retener aclarado", "Stop risciacquo"),
    ("noSpin", "No spin", "Sans essorage", "Ohne Schleudern", "Sin centrifugado", "Senza centrifuga"),
] + [(s, f"{s} rpm", f"{s} tr/min", f"{s} U/min", f"{s} rpm", f"{s} giri") for s in ("400", "800", "1200", "1400")]

RINSES = [(str(i), str(i), str(i), str(i), str(i), str(i)) for i in range(6)]

#            key        name                attr          supported               setter            enum?  labels (one per LANGS)                                   values
CAPABILITIES = [
    ("washerProgramme", "Washer Programme", "programme", "supportedProgrammes", "setProgramme", False,
     ["Programme", "Programme", "Programm", "Programa", "Programma"], PROGRAMMES),
    ("washerTemperature", "Washer Temperature", "temperature", "supportedTemperatures", "setTemperature", True,
     ["Temperature", "Température", "Temperatur", "Temperatura", "Temperatura"], TEMPERATURES),
    ("washerSpin", "Washer Spin", "spin", "supportedSpins", "setSpin", True,
     ["Spin", "Essorage", "Schleudern", "Centrifugado", "Centrifuga"], SPINS),
    ("washerRinse", "Washer Rinse", "rinse", "supportedRinses", "setRinse", True,
     ["Rinses", "Rinçages", "Spülgänge", "Aclarados", "Risciacqui"], RINSES),
]


def capability(name, attr, supported, setter, use_enum, values):
    item = {"type": "string"}
    if use_enum:
        item["enum"] = [v[0] for v in values]
    return {
        "name": name,
        "attributes": {
            attr: {"schema": {"type": "object", "properties": {"value": dict(item)}, "additionalProperties": False,
                              "required": ["value"]}, "setter": setter, "enumCommands": []},
            supported: {"schema": {"type": "object", "properties": {"value": {"type": "array", "items": dict(item)}},
                                   "additionalProperties": False, "required": ["value"]}, "enumCommands": []},
        },
        "commands": {setter: {"name": setter, "arguments": [{"name": "value", "optional": False, "schema": dict(item)}]}},
    }


def presentation(attr, supported, setter, values):
    alts = [{"key": v[0], "value": "{{i18n.attributes.%s.i18n.value.%s.label}}" % (attr, v[0]), "type": "active"}
            for v in values]
    label = "{{i18n.label}}"
    return {
        "dashboard": {"states": [], "actions": []},
        "detailView": [{"label": label, "displayType": "list", "list": {
            "command": {"name": setter, "alternatives": alts, "supportedValues": f"{supported}.value"},
            "state": {"value": f"{attr}.value", "valueType": "string", "alternatives": alts}}}],
        "automation": {
            "conditions": [{"label": label, "displayType": "list",
                            "list": {"alternatives": alts, "value": f"{attr}.value", "valueType": "string"}}],
            "actions": [{"label": label, "displayType": "list",
                         "list": {"alternatives": alts, "command": setter, "argumentType": "string",
                                  "supportedValues": f"{supported}.value"}}],
        },
    }


def translation(lang_index, lang, label, attr, values):
    return {
        "tag": lang,
        "label": label,
        "attributes": {attr: {
            "label": label,
            "displayTemplate": "{{device.label}}: {{value}}",
            "i18n": {"value": {v[0]: {"label": v[1 + lang_index]} for v in values}},
        }},
    }


# Read-only remaining time, shown on the dashboard tile like the dryer's.
REMAINING_LABELS = ["Remaining time", "Temps restant", "Restzeit", "Tiempo restante", "Tempo residuo"]


def remaining_capability():
    return {
        "name": "Washer Remaining Time",
        "attributes": {
            "remainingTime": {"schema": {"type": "object", "properties": {
                "value": {"type": "integer", "minimum": 0, "maximum": 1440},
                "unit": {"type": "string", "enum": ["min"], "default": "min"}},
                "additionalProperties": False, "required": ["value"]}, "enumCommands": []},
            "remainingTimeStr": {"schema": {"type": "object", "properties": {"value": {"type": "string"}},
                                            "additionalProperties": False, "required": ["value"]}, "enumCommands": []},
        },
        "commands": {},
    }


def remaining_presentation():
    return {
        "dashboard": {"states": [{"label": "{{remainingTimeStr.value}}"}], "actions": []},
        "detailView": [{"label": "{{i18n.label}}", "displayType": "state",
                        "state": {"label": "{{remainingTimeStr.value}}"}}],
        "automation": {
            "conditions": [{"label": "{{i18n.label}}", "displayType": "numberField",
                            "numberField": {"value": "remainingTime.value", "valueType": "integer", "unit": "remainingTime.unit",
                                            "range": [0, 1440]}}],
            "actions": [],
        },
    }


def remaining_translation(lang_index, lang):
    label = REMAINING_LABELS[lang_index]
    return {"tag": lang, "label": label, "attributes": {
        "remainingTime": {"label": label, "displayTemplate": "{{device.label}}: {{value}} min"},
        "remainingTimeStr": {"label": label, "displayTemplate": "{{device.label}}: {{value}}"},
    }}


# Capabilities with several attributes: (attribute, labels per LANGS, setter or None, values).
# Values: (key, labels per LANGS). Settable attributes become lists, read-only ones states.
ON_OFF = [("enabled", "On", "Activé", "Ein", "Activado", "Attivo"),
          ("disabled", "Off", "Désactivé", "Aus", "Desactivado", "Disattivo"),
          ("unavailable", "Not used by this programme", "Non utilisé par ce programme",
           "Bei diesem Programm nicht verwendet", "No se usa en este programa", "Non usato in questo programma")]
LEVEL = [("normal", "OK", "OK", "OK", "OK", "OK"),
         ("low", "Low", "Bas", "Niedrig", "Bajo", "Basso"),
         ("empty", "Empty", "Vide", "Leer", "Vacío", "Vuoto"),
         ("unknown", "Unknown", "Inconnu", "Unbekannt", "Desconocido", "Sconosciuto")]
ALERT = [("ok", "OK", "OK", "OK", "OK", "OK"),
         ("alert", "Needs attention", "À vérifier", "Prüfen", "Revisar", "Da controllare")]
MULTI = [
    ("washerDispenser", "Washer Dispenser",
     ["Auto dispenser", "Distributeur automatique", "Automatische Dosierung", "Dosificador automático", "Dosatore automatico"],
     [("autoDetergent", ["Auto detergent", "Lessive automatique", "Waschmittel automatisch", "Detergente automático", "Detersivo automatico"], "setAutoDetergent", ON_OFF[:2], ON_OFF),
      ("autoSoftener", ["Auto softener", "Adoucissant automatique", "Weichspüler automatisch", "Suavizante automático", "Ammorbidente automatico"], "setAutoSoftener", ON_OFF[:2], ON_OFF),
      ("detergentLevel", ["Detergent tank", "Réservoir de lessive", "Waschmitteltank", "Depósito de detergente", "Serbatoio detersivo"], None, None, LEVEL),
      ("softenerLevel", ["Softener tank", "Réservoir d'adoucissant", "Weichspülertank", "Depósito de suavizante", "Serbatoio ammorbidente"], None, None, LEVEL),
      ("drawer", ["Dispenser drawer", "Tiroir à lessive", "Waschmittelschublade", "Cajón del detergente", "Cassetto detersivo"], None, None,
       [("closed", "Closed", "Fermé", "Geschlossen", "Cerrado", "Chiuso"), ("open", "Open", "Ouvert", "Offen", "Abierto", "Aperto")])]),
    ("washerAlerts", "Washer Alerts",
     ["Maintenance", "Entretien", "Wartung", "Mantenimiento", "Manutenzione"],
     [("drumClean", ["Drum clean", "Nettoyage du tambour", "Trommelreinigung", "Limpieza del tambor", "Pulizia cestello"], None, None,
       [("ok", "OK", "OK", "OK", "OK", "OK"), ("alert", "Due", "À faire", "Fällig", "Pendiente", "Da fare")]),
      ("filter", ["Filter", "Filtre", "Filter", "Filtro", "Filtro"], None, None, ALERT),
      ("hotDoor", ["Hot door", "Porte chaude", "Heiße Tür", "Puerta caliente", "Oblò caldo"], None, None,
       [("ok", "No", "Non", "Nein", "No", "No"), ("alert", "Careful, hot", "Attention, chaude", "Vorsicht, heiß", "Cuidado, caliente", "Attenzione, caldo")]),
      ("dispenserFault", ["Dispenser fault", "Anomalie du distributeur", "Dosierstörung", "Fallo del dosificador", "Guasto dosatore"], None, None, ALERT),
      ("error", ["Error", "Erreur", "Fehler", "Error", "Errore"], None, None, None)]),
    ("washerChildLock", "Washer Child Lock",
     ["Child lock", "Sécurité enfant", "Kindersicherung", "Bloqueo infantil", "Blocco bambini"],
     [("childLock", ["Child lock", "Sécurité enfant", "Kindersicherung", "Bloqueo infantil", "Blocco bambini"], "setChildLock", ON_OFF[:2], ON_OFF[:2])]),
]


def multi_capability(name, fields):
    attrs, cmds = {}, {}
    for attr, _labels, setter, settable, values in fields:
        item = {"type": "string"}
        if values:
            item["enum"] = [v[0] for v in values]
        a = {"schema": {"type": "object", "properties": {"value": item}, "additionalProperties": False,
                        "required": ["value"]}, "enumCommands": []}
        if setter:
            a["setter"] = setter
            cmds[setter] = {"name": setter, "arguments": [{"name": "value", "optional": False,
                            "schema": {"type": "string", "enum": [v[0] for v in settable]}}]}
        attrs[attr] = a
    return {"name": name, "attributes": attrs, "commands": cmds}


def multi_presentation(fields):
    detail, conditions, actions = [], [], []
    for attr, _labels, setter, settable, values in fields:
        label = "{{i18n.attributes.%s.label}}" % attr
        if values:
            alts = [{"key": v[0], "value": "{{i18n.attributes.%s.i18n.value.%s.label}}" % (attr, v[0]), "type": "active"}
                    for v in values]
            conditions.append({"label": label, "displayType": "list",
                               "list": {"alternatives": alts, "value": f"{attr}.value", "valueType": "string"}})
        if setter:
            cmd_alts = [{"key": v[0], "value": "{{i18n.attributes.%s.i18n.value.%s.label}}" % (attr, v[0]), "type": "active"}
                        for v in settable]
            detail.append({"label": label, "displayType": "list", "list": {
                "command": {"name": setter, "alternatives": cmd_alts},
                "state": {"value": f"{attr}.value", "valueType": "string", "alternatives": alts}}})
            actions.append({"label": label, "displayType": "list",
                            "list": {"alternatives": cmd_alts, "command": setter, "argumentType": "string"}})
        elif values:
            # Read-only: a state, its value translated through alternatives.
            detail.append({"label": label, "displayType": "state",
                           "state": {"label": "{{%s.value}}" % attr, "alternatives": alts}})
        else:
            detail.append({"label": label, "displayType": "state", "state": {"label": "{{%s.value}}" % attr}})
    return {"dashboard": {"states": [], "actions": []}, "detailView": detail,
            "automation": {"conditions": conditions, "actions": actions}}


def multi_translation(lang_index, lang, cap_labels, fields):
    attrs = {}
    for attr, labels, _setter, _settable, values in fields:
        a = {"label": labels[lang_index], "displayTemplate": "{{device.label}}: {{value}}"}
        if values:
            a["i18n"] = {"value": {v[0]: {"label": v[1 + lang_index]} for v in values}}
        attrs[attr] = a
    return {"tag": lang, "label": cap_labels[lang_index], "attributes": attrs}


def main():
    namespace = sys.argv[1] if len(sys.argv) > 1 else "<namespace>"
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
    os.makedirs(out, exist_ok=True)
    for key, name, attr, supported, setter, use_enum, labels, values in CAPABILITIES:
        def dump(suffix, data):
            with open(os.path.join(out, f"{key}{suffix}.json"), "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
        dump("", capability(name, attr, supported, setter, use_enum, values))
        dump(".presentation", presentation(attr, supported, setter, values))
        for i, lang in enumerate(LANGS):
            dump(f".{lang}", translation(i, lang, labels[i], attr, values))
    with open(os.path.join(out, "washerRemainingTime.json"), "w", encoding="utf-8") as f:
        json.dump(remaining_capability(), f, indent=2, ensure_ascii=False)
    with open(os.path.join(out, "washerRemainingTime.presentation.json"), "w", encoding="utf-8") as f:
        json.dump(remaining_presentation(), f, indent=2, ensure_ascii=False)
    for i, lang in enumerate(LANGS):
        with open(os.path.join(out, f"washerRemainingTime.{lang}.json"), "w", encoding="utf-8") as f:
            json.dump(remaining_translation(i, lang), f, indent=2, ensure_ascii=False)
    for key, name, cap_labels, fields in MULTI:
        with open(os.path.join(out, f"{key}.json"), "w", encoding="utf-8") as f:
            json.dump(multi_capability(name, fields), f, indent=2, ensure_ascii=False)
        with open(os.path.join(out, f"{key}.presentation.json"), "w", encoding="utf-8") as f:
            json.dump(multi_presentation(fields), f, indent=2, ensure_ascii=False)
        for i, lang in enumerate(LANGS):
            with open(os.path.join(out, f"{key}.{lang}.json"), "w", encoding="utf-8") as f:
                json.dump(multi_translation(i, lang, cap_labels, fields), f, indent=2, ensure_ascii=False)
    print(f"{len(CAPABILITIES) + 1 + len(MULTI)} capabilities generated in {out} (namespace {namespace})")


if __name__ == "__main__":
    main()
