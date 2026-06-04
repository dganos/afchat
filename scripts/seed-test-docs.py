"""Generate 20 fake aviation manuals into resources/documents/test-manuals/.

Each file is a markdown manual with consistent sections (specs, pre-flight,
procedures, emergencies, maintenance) so the document-grounded agent has
plenty of cross-document content to search and cite.

Re-run anytime to refresh: `scripts/.venv/bin/python scripts/seed-test-docs.py`
"""
from pathlib import Path
import random
import textwrap

OUT_DIR = Path("resources/documents/test-manuals")

# All entries are fictional. Specs are internally consistent but invented.
HELIS = [
    dict(model="AeroCorp HX-450", role="light utility",
         crew=2, pax=4, mtow_kg=2400, max_speed_kt=140, ceiling_ft=15000,
         range_nm=380, fuel_l=620, rotor_dia_m=10.4,
         engine="single turboshaft, 720 SHP", quirks=[
             "Cyclic trim hold disengages above 100 KIAS",
             "Tail rotor authority degrades in left crosswind > 25 kt",
         ]),
    dict(model="Heliotrope Z-7", role="medium twin",
         crew=2, pax=12, mtow_kg=5800, max_speed_kt=155, ceiling_ft=18000,
         range_nm=540, fuel_l=1450, rotor_dia_m=13.8,
         engine="twin turboshaft, 2 × 940 SHP", quirks=[
             "FADEC reverts to manual fuel control on dual generator loss",
             "Vibration band at 220 rpm — avoid sustained operation",
         ]),
    dict(model="Stratos R-22 Talon", role="primary training",
         crew=1, pax=1, mtow_kg=720, max_speed_kt=102, ceiling_ft=13500,
         range_nm=240, fuel_l=110, rotor_dia_m=7.7,
         engine="piston, 145 HP derated to 124 HP", quirks=[
             "Low-inertia rotor — autorotation entry within 1.1 sec",
             "Carb heat mandatory below 18 °C OAT",
         ]),
    dict(model="Apex MH-90 Skyhawk", role="military light attack",
         crew=2, pax=4, mtow_kg=3100, max_speed_kt=165, ceiling_ft=16500,
         range_nm=420, fuel_l=780, rotor_dia_m=11.0,
         engine="twin turboshaft, 2 × 560 SHP", quirks=[
             "Stub-wing stores limit max bank to 45° above 120 KIAS",
             "Chaff/flare dispenser arming inhibits autopilot",
         ]),
    dict(model="Bell Comet 505", role="light commercial",
         crew=1, pax=4, mtow_kg=1670, max_speed_kt=125, ceiling_ft=14000,
         range_nm=305, fuel_l=410, rotor_dia_m=11.3,
         engine="single turboshaft, 504 SHP", quirks=[
             "Avoid prolonged hover with tailwind > 10 kt — LTE risk",
         ]),
    dict(model="Vortex 12 Thunder", role="heavy cargo lift",
         crew=3, pax=0, mtow_kg=15800, max_speed_kt=145, ceiling_ft=17000,
         range_nm=480, fuel_l=4200, rotor_dia_m=18.6,
         engine="twin turboshaft, 2 × 3800 SHP", quirks=[
             "External load release inhibited unless cargo hook armed",
             "Ground resonance possible on uneven surfaces — avoid > 60% Nr on ground",
         ]),
    dict(model="Polaris H-3 Arctic", role="cold-weather operations",
         crew=2, pax=8, mtow_kg=4800, max_speed_kt=138, ceiling_ft=15500,
         range_nm=460, fuel_l=1200, rotor_dia_m=12.9,
         engine="twin turboshaft, 2 × 780 SHP", quirks=[
             "Engine inlet anti-ice mandatory below 4 °C OAT in visible moisture",
             "Battery heat blanket required for cold-soak below −20 °C",
         ]),
    dict(model="Mercury K-150 MediStar", role="air ambulance",
         crew=2, pax=2, mtow_kg=2900, max_speed_kt=148, ceiling_ft=15000,
         range_nm=400, fuel_l=720, rotor_dia_m=10.7,
         engine="single turboshaft, 850 SHP", quirks=[
             "Patient O₂ system pressure check during pre-flight",
             "Night IFR requires both attitude indicators operative",
         ]),
    dict(model="Falcon HX-12 Observer", role="observation / surveillance",
         crew=2, pax=2, mtow_kg=2100, max_speed_kt=135, ceiling_ft=16000,
         range_nm=360, fuel_l=560, rotor_dia_m=10.0,
         engine="single turboshaft, 650 SHP", quirks=[
             "Gyro-stabilised sensor mount inhibits collective above 90% Tq",
         ]),
    dict(model="Zenith RH-8 Sport", role="sport / private",
         crew=1, pax=1, mtow_kg=680, max_speed_kt=98, ceiling_ft=12000,
         range_nm=210, fuel_l=95, rotor_dia_m=7.2,
         engine="piston, 115 HP", quirks=[
             "Pre-rotation clutch must be fully disengaged before lift-off",
         ]),
]

PLANES = [
    dict(model="Skywind A210", role="single-engine touring",
         crew=1, pax=3, mtow_kg=1340, max_speed_kt=148, ceiling_ft=14000,
         range_nm=720, fuel_l=210, wing_span_m=11.0,
         engine="single piston, 200 HP", quirks=[
             "Carb heat full on for any descent at reduced power",
             "Aux fuel pump on for take-off and landing",
         ]),
    dict(model="Atlas 727 Cargomaster", role="heavy freighter",
         crew=3, pax=0, mtow_kg=78000, max_speed_kt=470, ceiling_ft=37000,
         range_nm=2400, fuel_l=42000, wing_span_m=33.0,
         engine="three turbofans, 3 × 64 kN", quirks=[
             "Cargo door requires hydraulic system B pressure to seal",
             "Mach trim inhibit at altitudes below FL250",
         ]),
    dict(model="Stratoliner C-90 Regional", role="regional jet",
         crew=2, pax=78, mtow_kg=39500, max_speed_kt=460, ceiling_ft=37000,
         range_nm=1800, fuel_l=11800, wing_span_m=26.2,
         engine="twin turbofan, 2 × 56 kN", quirks=[
             "Anti-skid inoperative — limit landing weight by 8%",
             "Single-engine ferry permitted only below FL250",
         ]),
    dict(model="Cirrus N-350 Voyager", role="touring single",
         crew=1, pax=4, mtow_kg=1540, max_speed_kt=185, ceiling_ft=25000,
         range_nm=1100, fuel_l=340, wing_span_m=11.7,
         engine="single piston, 310 HP turbocharged", quirks=[
             "Airframe parachute armed below 600 ft AGL only as last resort",
             "Use intercooler bypass for cruise climbs above FL180",
         ]),
    dict(model="Velocity V-Fast LSA", role="light sport",
         crew=1, pax=1, mtow_kg=600, max_speed_kt=120, ceiling_ft=12500,
         range_nm=520, fuel_l=85, wing_span_m=8.8,
         engine="single piston, 100 HP Rotax", quirks=[
             "Coolant temperature ≥ 50 °C required before take-off run-up",
         ]),
    dict(model="Galaxy 988 Wingstar", role="long-haul wide-body",
         crew=3, pax=312, mtow_kg=255000, max_speed_kt=490, ceiling_ft=41000,
         range_nm=7800, fuel_l=174000, wing_span_m=64.0,
         engine="twin turbofan, 2 × 360 kN", quirks=[
             "ETOPS-330 dispatch requires both hydraulic engine pumps operative",
             "Center tank pumps off when quantity below 600 kg",
         ]),
    dict(model="Trident X-3 Twin", role="twin turboprop",
         crew=2, pax=19, mtow_kg=8400, max_speed_kt=290, ceiling_ft=28000,
         range_nm=1300, fuel_l=2200, wing_span_m=17.5,
         engine="twin turboprop, 2 × 1100 SHP", quirks=[
             "Auto-feather armed for take-off and arming verified by light",
             "Yaw damper required above FL200",
         ]),
    dict(model="Nimbus L-200 Bushwhacker", role="STOL bush",
         crew=1, pax=5, mtow_kg=1620, max_speed_kt=110, ceiling_ft=17000,
         range_nm=420, fuel_l=240, wing_span_m=10.8,
         engine="single piston, 230 HP", quirks=[
             "Vortex generators give stall warning ≥ 4 kt before break",
             "Tundra tires increase take-off roll by 18% on hard surfaces",
         ]),
    dict(model="Phoenix F-44 Aerobat", role="aerobatic",
         crew=1, pax=1, mtow_kg=820, max_speed_kt=200, ceiling_ft=16000,
         range_nm=380, fuel_l=120, wing_span_m=7.9,
         engine="single piston, 260 HP inverted-fuel", quirks=[
             "Inverted flight limited to 90 seconds — oil pickup limitation",
             "Smoke system fuel separate; do not cross-feed",
         ]),
    dict(model="Hercules T-130 Tactical", role="military transport",
         crew=4, pax=92, mtow_kg=70300, max_speed_kt=320, ceiling_ft=28000,
         range_nm=2200, fuel_l=20800, wing_span_m=40.4,
         engine="four turboprop, 4 × 4600 SHP", quirks=[
             "Low-level mode disables GPWS terrain alerts below 500 ft AGL",
             "Reverse thrust on ground only — interlock with WoW switch",
         ]),
]


PREFLIGHT_HELI = [
    "Walk-around: blade condition, droop stops free, no Jesus-nut play",
    "Tail rotor: check pitch links, control rod, no slop in pedal feedback",
    "Engine cowling secured, oil quantity within green band",
    "Fuel sample drained for water/sediment from sump and tank low point",
    "Mast and swashplate visually inspected for cracks or oil weep",
    "Battery voltage ≥ 24 V before start; ground power off",
    "Skid/gear shock absorbers extended, no fluid leakage on collars",
    "Pitot heat checked operative; static ports clear",
    "Doors, latches, and cargo nets secured",
    "Cyclic, collective, and pedals free and correct travel",
]
PREFLIGHT_PLANE = [
    "Walk-around: control surface hinges, no fuel/oil staining around cowl",
    "Pitot–static system covers removed, drains clear",
    "Fuel sumps drained at all low points; sample colour and clarity checked",
    "Tyre pressure and strut extension within limits",
    "Trim tabs neutral and free; flap retraction confirmed",
    "Propeller spinner secure, blade leading edges undamaged",
    "Engine oil within green arc, dipstick re-seated",
    "Static ports unobstructed and pitot heat operative",
    "Brake reservoir level and parking brake function checked",
    "Stall warning vane free, audible warning operative",
]

EMERGENCIES_HELI = [
    ("Engine failure in cruise", [
        "Lower collective immediately to maintain rotor RPM in green band",
        "Establish 60–70 KIAS for best autorotation glide",
        "Select landing area into wind, avoid wires and slopes > 5°",
        "Mayday on 121.5; squawk 7700",
        "Flare at 75 ft, level at 15 ft, cushion with collective",
    ]),
    ("Tail rotor drive failure", [
        "Immediately reduce power; close throttle on piston ships",
        "Lower collective to keep yaw rate manageable",
        "Establish forward airspeed for streamlining (min 45 KIAS)",
        "Plan run-on landing into wind on a hard surface",
        "Touch down with minimum power, full down collective at slide stop",
    ]),
    ("Engine fire on the ground", [
        "Throttle to idle cut-off, fuel valve OFF",
        "Battery and generator OFF",
        "Evacuate via upwind door; use fire extinguisher only after evac if safe",
        "Notify ATC and ground crew",
    ]),
]
EMERGENCIES_PLANE = [
    ("Engine failure after take-off", [
        "Lower the nose immediately to maintain best-glide airspeed",
        "Fuel pump ON, mixture rich, magnetos BOTH, fuel selector to fullest tank",
        "If no restart by 300 ft AGL: commit to land within ±30° of nose",
        "Master switch off short final; door cracked open",
        "Mayday on 121.5; squawk 7700",
    ]),
    ("Electrical smoke or fire", [
        "Master switch OFF immediately",
        "Cabin vents open; cabin heat OFF",
        "Land as soon as practical; non-essential equipment OFF",
        "If smoke persists with master off, suspect cabin source — locate and isolate",
    ]),
    ("Loss of pressurisation", [
        "Don oxygen masks, 100% setting",
        "Emergency descent: throttle idle, speed brake out, target 10,000 ft",
        "Notify ATC, request lower altitude",
        "Check passenger oxygen deployed and flow indicators green",
    ]),
]


TEMPLATE = """# {model} — Pilot Operating Handbook

*Document number: AR-POH-{docnum:03d}  ·  Revision: 4.2  ·  Effective: 2026-01-15*

The {model} is a {role} aircraft used by training, commercial, and
research operators. This manual covers normal and emergency operating
procedures, weight-and-balance limits, and the minimum equipment list
sufficient for daylight VFR dispatch. Crews must hold a current type
rating on the {family} and complete a yearly recurrency check.

## 1. Specifications

| Parameter | Value |
|-----------|-------|
| Crew | {crew} |
| Passengers | {pax} |
| Maximum take-off weight | {mtow_kg:,} kg |
| Maximum cruise speed | {max_speed_kt} KIAS |
| Service ceiling | {ceiling_ft:,} ft |
| Maximum range | {range_nm:,} nm |
| Usable fuel capacity | {fuel_l:,} L |
| {span_label} | {span_val} m |
| Powerplant | {engine} |

## 2. Pre-flight Inspection

The pre-flight check is mandatory before every departure regardless of
the time since the previous flight. Discrepancies must be entered in the
aircraft technical log.

{preflight_block}

## 3. Normal Procedures

### 3.1 Start-up

1. Master switch ON, avionics OFF.
2. Fuel selector to the fullest tank (single-engine) or BOTH (twin).
3. Mixture rich (piston) / condition lever IDLE (turbine).
4. Throttle cracked 1 cm; pre-rotate / motor as applicable.
5. Confirm start within 30 seconds; abort if ITT/CHT exceeds limits.

### 3.2 Take-off

1. Cleared for take-off — align with runway centerline.
2. Apply power smoothly to {takeoff_power}.
3. Rotate / lift at {rotate_speed}.
4. Climb attitude {climb_attitude}; positive rate, gear up if equipped.
5. Reduce to climb power at 400 ft AGL.

### 3.3 Cruise

Trim for level flight at cruise altitude. Monitor engine instruments
every 10 minutes; fuel flow should remain within ±5% of planned.
Avoid the vibration band at {vibration_band} for sustained operation.

### 3.4 Landing

Reduce power at the IAF. Configure for landing on base leg. Maintain
{approach_speed} on final; touchdown target is the first third of the
runway / landing zone. Apply braking smoothly to taxi speed.

## 4. Emergency Procedures

{emergencies_block}

## 5. Aircraft-Specific Cautions

{quirks_block}

## 6. Weight and Balance

Empty weight is recorded on the aircraft equipment list. Pilots must
calculate take-off and landing weights, and verify the centre of
gravity falls within the published envelope. Operating outside the
envelope is prohibited.

## 7. Minimum Equipment

For VFR-day dispatch the following must be operative:

- Primary attitude indicator
- Altimeter (Kollsman-adjustable)
- Airspeed indicator
- Magnetic compass
- Engine RPM/torque indication
- Fuel quantity indicator (each tank)
- Communications radio (one operative)

## 8. Maintenance Schedule

- **50 hr** — oil change, filter inspection, control rigging check
- **100 hr** — full airframe inspection, magneto timing
- **300 hr** — gearbox/transmission filter, blade tracking
- **Annual** — comprehensive airworthiness inspection
- **Calendar** — pitot–static and transponder check every 24 months
"""


def make_preflight(items):
    return "\n".join(f"{i+1}. {item}" for i, item in enumerate(items))


def make_emergencies(blocks):
    out = []
    for i, (title, steps) in enumerate(blocks, start=1):
        out.append(f"### 4.{i} {title}\n")
        for j, s in enumerate(steps, start=1):
            out.append(f"{j}. {s}")
        out.append("")
    return "\n".join(out)


def make_quirks(quirks):
    return "\n".join(f"- {q}" for q in quirks)


def slugify(name):
    return (
        name.lower()
        .replace(" ", "-")
        .replace("/", "-")
        .replace(".", "")
        .replace("—", "-")
    )


def render(entry, *, kind, docnum):
    is_heli = kind == "heli"
    preflight = make_preflight(PREFLIGHT_HELI if is_heli else PREFLIGHT_PLANE)
    emergencies = make_emergencies(EMERGENCIES_HELI if is_heli else EMERGENCIES_PLANE)
    quirks = make_quirks(entry["quirks"])
    span_label = "Rotor diameter" if is_heli else "Wing span"
    span_val = entry.get("rotor_dia_m") if is_heli else entry.get("wing_span_m")
    rotate_speed = "ETL (effective translational lift)" if is_heli else f"{int(entry['max_speed_kt']*0.55)} KIAS"
    takeoff_power = "max continuous torque" if is_heli else "full throttle, target 92% N1 or 2700 RPM"
    climb_attitude = "5–7° nose up" if is_heli else "8–10° nose up"
    approach_speed = f"{int(entry['max_speed_kt']*0.45)} KIAS" if is_heli else f"{int(entry['max_speed_kt']*0.32)} KIAS"
    vibration_band = "65–72% Nr" if is_heli else "1850–1950 RPM"
    family = entry["model"].split()[0]
    body = TEMPLATE.format(
        model=entry["model"],
        role=entry["role"],
        family=family,
        crew=entry["crew"],
        pax=entry["pax"],
        mtow_kg=entry["mtow_kg"],
        max_speed_kt=entry["max_speed_kt"],
        ceiling_ft=entry["ceiling_ft"],
        range_nm=entry["range_nm"],
        fuel_l=entry["fuel_l"],
        span_label=span_label,
        span_val=span_val,
        engine=entry["engine"],
        preflight_block=preflight,
        emergencies_block=emergencies,
        quirks_block=quirks,
        docnum=docnum,
        takeoff_power=takeoff_power,
        rotate_speed=rotate_speed,
        climb_attitude=climb_attitude,
        approach_speed=approach_speed,
        vibration_band=vibration_band,
    )
    return body


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    docnum = 1
    written = 0
    for entry in HELIS:
        path = OUT_DIR / f"{slugify(entry['model'])}-heli.md"
        path.write_text(render(entry, kind="heli", docnum=docnum), encoding="utf-8")
        docnum += 1
        written += 1
    for entry in PLANES:
        path = OUT_DIR / f"{slugify(entry['model'])}-plane.md"
        path.write_text(render(entry, kind="plane", docnum=docnum), encoding="utf-8")
        docnum += 1
        written += 1
    print(f"wrote {written} files to {OUT_DIR}")


if __name__ == "__main__":
    main()
