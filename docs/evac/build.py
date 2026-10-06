#!/usr/bin/env python3
"""Builds docs/evac/evacuation-plan.html — a tabloid (17x11 in) emergency
evacuation plan for Sunspace USA, Truesdale. Run: python3 build.py

The floor plan is drawn in "plan units" (the building as the hand-marked
draft shows it, turned upright so the office is on the left / south end),
then scaled into the map card. Edit the lists below to move a door, an
extinguisher or a label, and run it again.
"""
GREEN, BLUE, YEL, RED, PURPLE = '#1E8A44', '#2563C9', '#F2B705', '#D7262E', '#6B3FA0'
INK = '#1C2127'

out = []
add = out.append

# ── drawing helpers (plan units) ─────────────────────────────
def text(x, y, s, size=22, weight=600, fill=INK, anchor='middle', extra=''):
    lines = s.split('\n')
    dy = size * 1.12
    y0 = y - (len(lines) - 1) * dy / 2
    tsp = ''.join(f'<tspan x="{x}" y="{y0 + i*dy:.1f}">{l}</tspan>' for i, l in enumerate(lines))
    return f'<text font-size="{size}" font-weight="{weight}" fill="{fill}" text-anchor="{anchor}" {extra}>{tsp}</text>'

def man_door(x, y, rot, color=GREEN, w=44):
    """A door in a wall: gap, leaf and swing arc. rot 0 = wall runs
    left-right and the door swings up; 90 right, 180 down, 270 left."""
    h = w / 2
    return (f'<g transform="translate({x} {y}) rotate({rot})">'
            f'<rect x="{-h}" y="-8" width="{w}" height="16" fill="#fff"/>'
            f'<path d="M {-h} {-w} A {w} {w} 0 0 1 {h} 0" fill="none" stroke="{color}" stroke-width="3" stroke-dasharray="7 5"/>'
            f'<line x1="{-h}" y1="0" x2="{-h}" y2="{-w}" stroke="{color}" stroke-width="6" stroke-linecap="round"/>'
            f'<circle cx="{-h}" cy="0" r="5" fill="{color}"/><circle cx="{h}" cy="0" r="4" fill="{color}"/></g>')

def overhead(x, y, rot, length=70):
    h = length / 2
    return (f'<g transform="translate({x} {y}) rotate({rot})">'
            f'<rect x="{-h}" y="-10" width="{length}" height="20" fill="#FFE08A" stroke="#C9950A" stroke-width="3" stroke-dasharray="9 5"/></g>')

def chip(x, y, label='EXIT', fill=GREEN, w=None, size=17):
    w = w or (len(label) * size * 0.68 + 18)
    return (f'<rect x="{x - w/2:.1f}" y="{y - size*0.85:.1f}" width="{w:.1f}" height="{size*1.5:.1f}" rx="5" fill="{fill}"/>'
            f'<text x="{x}" y="{y + size*0.38:.1f}" font-size="{size}" font-weight="800" fill="#fff" text-anchor="middle">{label}</text>')

def extinguisher(x, y):
    return (f'<circle cx="{x}" cy="{y}" r="15" fill="{RED}" stroke="#fff" stroke-width="2.5"/>'
            f'<text x="{x}" y="{y+6}" font-size="18" font-weight="800" fill="#fff" text-anchor="middle">F</text>')

def route(points, color=GREEN):
    d = 'M ' + ' L '.join(f'{x} {y}' for x, y in points)
    return f'<path d="{d}" fill="none" stroke="{color}" stroke-width="7" stroke-linejoin="round" stroke-linecap="round" marker-end="url(#ah)" opacity=".9"/>'

# ── the plan ─────────────────────────────────────────────────
BUILDING = [(380,1010),(380,465),(1040,465),(1040,285),(1945,285),(1945,1000),(1440,1000),(1440,1090),(480,1090),(480,1010)]
plan = []
p = plan.append
pts = ' '.join(f'{x},{y}' for x, y in BUILDING)
p(f'<polygon points="{pts}" fill="#F4F6F9" stroke="{INK}" stroke-width="10" stroke-linejoin="miter"/>')

# Office, on the south end, with its main door facing the muster side
p(f'<rect x="255" y="565" width="125" height="280" fill="#E3E8EF" stroke="{INK}" stroke-width="9"/>')
p(text(318, 700, 'OFFICE', 26, 800))
p(text(318, 730, 'main door ◂', 16, 600, '#46505C'))

# Zones (dashed) and benches
zone = f'fill="none" stroke="#8893A1" stroke-width="3" stroke-dasharray="14 9"'
p(f'<line x1="1048" y1="455" x2="1940" y2="455" {zone[zone.index("stroke"):]}/>')
p(text(1495, 372, 'PANEL PLANT AREA', 36, 800, '#46505C'))
p(f'<line x1="625" y1="1000" x2="1435" y2="1000" {zone[zone.index("stroke"):]}/>')
p(text(1030, 1045, 'MANUAL CUT – SAW AREA', 24, 700, '#46505C'))
p(f'<line x1="625" y1="672" x2="625" y2="1000" {zone[zone.index("stroke"):]}/>')
p(text(548, 862, 'MACHINE\nAREA', 21, 700, '#46505C'))

p(f'<rect x="760" y="585" width="390" height="96" rx="6" fill="#DCE3EC" stroke="#333" stroke-width="4"/>')
p(text(955, 646, 'MODS DEPT', 34, 800))
p(f'<rect x="760" y="712" width="395" height="88" rx="6" fill="#DCE3EC" stroke="#333" stroke-width="4"/>')
p(text(957, 770, 'V4T DEPT', 34, 800))

# Compressor room
p(f'<rect x="820" y="465" width="104" height="58" fill="#E9EDF2" stroke="#333" stroke-width="5"/>')
p(text(872, 491, 'Compressor\nroom', 14, 700, '#46505C'))

# Washrooms = tornado shelter
p(f'<rect x="555" y="465" width="145" height="82" fill="#E7DDF6" stroke="{PURPLE}" stroke-width="5"/>')
p(f'<line x1="627" y1="465" x2="627" y2="547" stroke="{PURPLE}" stroke-width="4"/>')
p(text(591, 505, 'MALE', 14, 700, PURPLE)); p(text(663, 505, 'FEMALE', 14, 700, PURPLE))
p(text(627, 622, 'TORNADO SHELTER', 17, 800, PURPLE))
p(text(627, 642, '(washrooms)', 14, 600, PURPLE))

# Washroom with eyewash, shipping office, area being built
p(f'<rect x="1472" y="640" width="130" height="82" fill="#E3EEFB" stroke="{BLUE}" stroke-width="5"/>')
p(text(1540, 672, 'WASHROOM', 18, 700, BLUE))
p(f'<circle cx="1510" cy="702" r="12" fill="{BLUE}"/><text x="1510" y="707" font-size="11" font-weight="800" fill="#fff" text-anchor="middle">EW</text>')
p(text(1568, 706, 'Eyewash\nstation', 13, 600, BLUE))
p(f'<rect x="1488" y="878" width="104" height="56" fill="#E9EDF2" stroke="#333" stroke-width="5"/>')
p(text(1540, 908, 'Shipping\noffice', 16, 700))
p('<defs><pattern id="hatch" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="14" stroke="#C3CAD4" stroke-width="5"/></pattern></defs>')
p(f'<rect x="1560" y="494" width="140" height="66" fill="url(#hatch)" stroke="#8893A1" stroke-width="3" stroke-dasharray="10 6"/>')
p(text(1630, 532, 'AREA BEING\nBUILT', 17, 800, '#46505C', extra='paint-order="stroke" stroke="#F4F6F9" stroke-width="5"'))

# Doors. Man doors are all exits; overhead and dock doors are not.
MAN = [  # x, y, rotation, chip label position (dx, dy)
    (515, 465, 0, (0, -62)),        # top wall, left section
    (610, 1090, 180, (82, 30)),     # bottom wall, left section (lower-left exit)
    (1150, 285, 0, (0, -62)),       # top wall, right section
    (1860, 285, 0, (0, -62)),       # top-right corner
    (1945, 590, 90, (66, 0)),       # right wall
    (1760, 1000, 180, (82, 30)),    # bottom wall, dock end
    (255, 705, 270, (-66, 0)),      # office main door
]
for x, y, rot, (dx, dy) in MAN:
    p(man_door(x, y, rot))
    p(chip(x + dx, y + dy + (6 if (dy and abs(dy) > 40) else 0)))
p(man_door(380, 765, 90, BLUE))                       # office -> plant
p(text(448, 730, 'Office → plant', 14, 700, BLUE, 'middle'))
p(man_door(591, 547, 180, BLUE, 34)); p(man_door(663, 547, 180, BLUE, 34))   # washrooms
p(man_door(1472, 681, 270, BLUE, 34))                 # eyewash washroom

OH = [(425, 465, 0, 60), (430, 1010, 180, 80), (1325, 285, 0, 80)]
for x, y, rot, l in OH: p(overhead(x, y, rot, l))
for x in (1470, 1512, 1554): p(overhead(x, 1000, 180, 34))   # 3 docks
p(overhead(1668, 1000, 180, 70))                              # big overhead door

# Door labels
p(text(405, 418, 'Overhead door\n(not an exit)', 15, 600, '#8A6606'))
p(text(452, 968, 'Overhead door\n(not an exit)', 14, 600, '#8A6606'))
p(text(1325, 238, 'Overhead door\n(not an exit)', 15, 600, '#8A6606'))
p(text(1512, 1050, '3 docks', 18, 700, '#8A6606'))
p(text(1668, 1050, 'Overhead door\n(big)', 15, 600, '#8A6606'))

# Evacuation routes (to the nearest man door)
for r in [
    [(570, 940), (590, 1062)],                       # machine area -> lower-left door
    [(850, 1050), (700, 1075), (625, 1078)],         # saw area -> lower-left door
    [(752, 697), (518, 697), (518, 488)],            # mods / V4T aisle -> top-left door
    [(1230, 400), (1160, 305)],                      # panel plant -> top door
    [(1790, 400), (1860, 305)],                      # panel plant -> top-right door
    [(1750, 590), (1925, 590)],                      # shipping floor -> right door
    [(1640, 880), (1748, 975)],                      # shipping area -> bottom door
    [(1330, 960), (1735, 972)],                      # along the dock side -> bottom door
]:
    p(route(r))

# Fire extinguishers — 17
FIRE = [(407,617),(462,800),(482,480),(478,1002),(663,1003),(955,490),(1045,478),(899,834),(1298,1003),
        (1388,822),(1190,333),(1448,303),(1525,632),(1646,305),(1713,985),(1913,302),(1883,620)]
assert len(FIRE) == 17
for x, y in FIRE: p(extinguisher(x, y))

# Muster point — one, at the south end by the lower-left man door
p(f'<circle cx="200" cy="1030" r="44" fill="{GREEN}" stroke="#fff" stroke-width="5"/>')
p(text(200, 1048, 'M', 52, 800, '#fff'))
p(text(200, 1112, 'MUSTER POINT', 22, 800, GREEN))
p(route([(560, 1130), (330, 1075), (250, 1050)], GREEN))

# Compass: the south end (office) is on the left
p(f'<line x1="160" y1="360" x2="420" y2="360" stroke="{INK}" stroke-width="5" marker-end="url(#ahk)"/>')
p(text(160, 335, 'SOUTH', 20, 700, '#46505C', 'start')); p(text(420, 335, 'NORTH', 20, 700, '#46505C', 'end'))

PLAN = '\n'.join(plan)

# ── the poster ───────────────────────────────────────────────
S = 0.66
TX, TY = -25.8, -5
legend_items = [
    (f'<circle cx="16" cy="16" r="13" fill="{RED}"/><text x="16" y="22" font-size="16" font-weight="800" fill="#fff" text-anchor="middle">F</text>', 'Fire extinguisher', '17 of them'),
    (f'<g transform="translate(10 30) scale(.62)">{man_door(0,0,0,GREEN,44)}</g>', 'Man door = EXIT', 'every man door can be used'),
    (f'<g transform="translate(10 30) scale(.62)">{man_door(0,0,0,BLUE,44)}</g>', 'Blue door', 'office → plant, washrooms'),
    (f'<g transform="translate(16 16)"><rect x="-16" y="-8" width="32" height="16" fill="#FFE08A" stroke="#C9950A" stroke-width="2.5" stroke-dasharray="7 4"/></g>', 'Overhead / dock door', 'NOT an exit'),
    (f'<circle cx="16" cy="16" r="14" fill="{GREEN}"/><text x="16" y="23" font-size="19" font-weight="800" fill="#fff" text-anchor="middle">M</text>', 'Muster point', 'meet here, then roll call'),
    (f'<rect x="2" y="5" width="28" height="22" fill="#E7DDF6" stroke="{PURPLE}" stroke-width="3"/>', 'Tornado shelter', 'male / female washrooms'),
    (f'<circle cx="16" cy="16" r="13" fill="{BLUE}"/><text x="16" y="20" font-size="11" font-weight="800" fill="#fff" text-anchor="middle">EW</text>', 'Eyewash station', 'in the washroom by shipping'),
    ('<path d="M 2 16 L 28 16" stroke="%s" stroke-width="6" marker-end="url(#ah)"/>' % GREEN, 'Exit route', 'to the nearest man door'),
]
leg = ''
for i, (icon, t1, t2) in enumerate(legend_items):
    y = 70 + i * 72
    leg += f'<g transform="translate(24 {y})">{icon}<text x="50" y="14" font-size="19" font-weight="700" fill="{INK}">{t1}</text><text x="50" y="35" font-size="15" fill="#5A6270">{t2}</text></g>'

def box(x, w, title, tcolor, body, extra=''):
    return f'''<g transform="translate({x} 780)"><rect width="{w}" height="270" rx="14" fill="#fff" stroke="#C9CED6" stroke-width="2.5"/>
    <text x="22" y="44" font-size="25" font-weight="800" fill="{tcolor}">{title}</text>{body}{extra}</g>'''

def steps(items, color):
    s = ''
    for i, (k, t) in enumerate(items):
        s += f'<text x="26" y="{92 + i*46}" font-size="30" font-weight="800" fill="{color}">{k}</text>'
        for j, line in enumerate(t.split('\n')):
            s += f'<text x="62" y="{86 + i*46 + j*20}" font-size="17" fill="{INK}">{line}</text>'
    return s

race = steps([('R', 'Remove people from the danger area.'),
              ('A', 'Alert people nearby and raise the alarm.\nDial 911 with your name and location.'),
              ('C', 'Confine fire and smoke.\nClose doors behind you.'),
              ('E', 'Extinguish or evacuate. Fight a fire only if\nyou are trained and it is safe.')], RED)
pass_ = steps([('P', 'Pull the pin'), ('A', 'Aim at the base of the fire'), ('S', 'Squeeze the handle'), ('S', 'Sweep side to side')], RED)
tornado = ('<text x="22" y="90" font-size="19" font-weight="700" fill="%s">Go to the washrooms (male / female).</text>' % INK +
           ''.join(f'<text x="22" y="{128 + i*30}" font-size="17" fill="{INK}">{t}</text>' for i, t in enumerate(
               ['• Stay away from overhead doors and docks', '• Close the washroom doors behind you', '• Stay put until the all-clear', '• Take a head count when you get there'])))
services = ('<text x="22" y="112" font-size="58" font-weight="800" fill="%s">DIAL 911</text>' % RED +
            ''.join(f'<text x="22" y="{150 + i*26}" font-size="17" fill="{INK}">{t}</text>' for i, t in enumerate(
                ['Go to the muster point (green M) at the south', 'end of the building. Stay there for roll call.', 'Do not re-enter until you are told it is safe.'])) +
            f'<text x="22" y="238" font-size="15" fill="#5A6270">Questions: Rizwan Khanjra · 519 778 7280</text>')

html = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Emergency Evacuation Plan — Sunspace USA, Truesdale</title>
<style>
  @page {{ size: 17in 11in; margin: 0 }}
  html, body {{ margin: 0; background: #fff }}
  svg {{ display: block; width: 17in; height: 11in; font-family: "Liberation Sans", Arial, Helvetica, sans-serif }}
  @media screen {{ body {{ background: #888 }} svg {{ margin: 12px auto; box-shadow: 0 2px 12px rgba(0,0,0,.4) }} }}
</style></head><body>
<svg viewBox="0 0 1700 1100" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Emergency evacuation plan">
  <defs>
    <marker id="ah" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="{GREEN}"/></marker>
    <marker id="ahk" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="{INK}"/></marker>
  </defs>
  <rect width="1700" height="1100" fill="#fff"/>
  <!-- header -->
  <rect x="0" y="0" width="1700" height="108" fill="#1F5F3A"/>
  <text x="40" y="76" font-size="62" font-weight="800" fill="#fff" letter-spacing="1">EMERGENCY EVACUATION PLAN</text>
  <text x="1670" y="52" font-size="30" font-weight="800" fill="#fff" text-anchor="end">Sunspace USA INC</text>
  <text x="1670" y="86" font-size="21" fill="#E6F1EA" text-anchor="end">1402 E Veterans Memorial Pkwy, Truesdale, MO 63380</text>
  <!-- map -->
  <rect x="30" y="128" width="1310" height="632" rx="14" fill="#fff" stroke="#C9CED6" stroke-width="2.5"/>
  <g transform="translate({TX} {TY}) scale({S})" font-family="Liberation Sans, Arial, sans-serif">
{PLAN}
  </g>
  <text x="1322" y="750" font-size="14" fill="#5A6270" text-anchor="end">Not to scale</text>
  <!-- legend -->
  <g transform="translate(1360 128)"><rect width="310" height="632" rx="14" fill="#fff" stroke="#C9CED6" stroke-width="2.5"/>
    <text x="24" y="44" font-size="26" font-weight="800" fill="{INK}" letter-spacing="1">LEGEND</text>{leg}</g>
  <!-- bottom boxes -->
  {box(30, 395, 'IF THERE IS A FIRE: R.A.C.E.', RED, race)}
  {box(445, 395, 'EXTINGUISHER GUIDE', RED, pass_)}
  {box(860, 395, 'TORNADO WARNING', PURPLE, tornado)}
  {box(1275, 395, 'EMERGENCY SERVICES', RED, services)}
  <text x="30" y="1082" font-size="15" fill="#5A6270">Reviewed by: ______________________   Date: ______________   Post at every exit and by the time clock.</text>
</svg></body></html>'''
open('evacuation-plan.html', 'w').write(html)
print('wrote evacuation-plan.html', len(html), 'bytes')
