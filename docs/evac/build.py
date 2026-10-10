#!/usr/bin/env python3
"""Builds docs/evac/evacuation-plan.html — tabloid (17x11 in) emergency
evacuation plan, Sunspace USA, Truesdale. Run: python3 build.py

Version 2 follows the typeset plan (numbered exits 1-7, exit key, assembly
point, you-are-here, gas main) with the hand-marked changes applied:
alternate point, employee entrance & smoking area, mailbox, first-aid
kits (FA), a second eyewash by the office.

The plan is drawn in "plan units", upright: NORTH is the LEFT end (office),
EAST is the TOP edge. Edit the lists, run again, then render.cjs.
"""
GREEN, BLUE, YEL, RED, PURPLE, ORANGE = '#1E8A44', '#2563C9', '#F2B705', '#D7262E', '#6B3FA0', '#E08A00'
INK = '#1C2127'
GREY = '#46505C'

plan = []
p = plan.append

def text(x, y, s, size=22, weight=600, fill=INK, anchor='middle', extra=''):
    lines = s.split('\n')
    dy = size * 1.12
    y0 = y - (len(lines) - 1) * dy / 2
    tsp = ''.join(f'<tspan x="{x}" y="{y0 + i*dy:.1f}">{l}</tspan>' for i, l in enumerate(lines))
    return f'<text font-size="{size}" font-weight="{weight}" fill="{fill}" text-anchor="{anchor}" {extra}>{tsp}</text>'

def man_door(x, y, rot, color=GREEN, w=44):
    h = w / 2
    return (f'<g transform="translate({x} {y}) rotate({rot})">'
            f'<rect x="{-h}" y="-8" width="{w}" height="16" fill="#fff"/>'
            f'<path d="M {-h} {-w} A {w} {w} 0 0 1 {h} 0" fill="none" stroke="{color}" stroke-width="3" stroke-dasharray="7 5"/>'
            f'<line x1="{-h}" y1="0" x2="{-h}" y2="{-w}" stroke="{color}" stroke-width="6" stroke-linecap="round"/>'
            f'<circle cx="{-h}" cy="0" r="5" fill="{color}"/><circle cx="{h}" cy="0" r="4" fill="{color}"/></g>')

def overhead(x, y, rot, length=70):
    h = length / 2
    return (f'<g transform="translate({x} {y}) rotate({rot})"><rect x="{-h}" y="-10" width="{length}" height="20" fill="#FFE08A" stroke="#C9950A" stroke-width="3" stroke-dasharray="9 5"/></g>')

def badge(x, y, n, size=26):
    s = size * 1.5
    return (f'<rect x="{x - s/2}" y="{y - s/2}" width="{s}" height="{s}" rx="6" fill="{GREEN}" stroke="#fff" stroke-width="3"/>'
            f'<text x="{x}" y="{y + size*0.36:.1f}" font-size="{size}" font-weight="800" fill="#fff" text-anchor="middle">{n}</text>')

def extinguisher(x, y):
    return (f'<circle cx="{x}" cy="{y}" r="15" fill="{RED}" stroke="#fff" stroke-width="2.5"/>'
            f'<text x="{x}" y="{y+6}" font-size="18" font-weight="800" fill="#fff" text-anchor="middle">F</text>')

def first_aid(x, y):
    return (f'<rect x="{x-16}" y="{y-16}" width="32" height="32" rx="5" fill="#fff" stroke="{GREEN}" stroke-width="4"/>'
            f'<path d="M {x-4} {y-11} h8 v7 h7 v8 h-7 v7 h-8 v-7 h-7 v-8 h7 z" fill="{GREEN}"/>'
            + text(x, y + 38, 'FA', 17, 800, GREEN))

def eyewash(x, y, label=True):
    return (f'<circle cx="{x}" cy="{y}" r="15" fill="{BLUE}" stroke="#fff" stroke-width="2.5"/>'
            f'<text x="{x}" y="{y+5}" font-size="13" font-weight="800" fill="#fff" text-anchor="middle">EW</text>')

def route(points, color=GREEN, dash=False, width=7):
    d = 'M ' + ' L '.join(f'{x} {y}' for x, y in points)
    da = ' stroke-dasharray="16 10"' if dash else ''
    m = 'ahy' if color == ORANGE else 'ah'
    return f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{width}" stroke-linejoin="round" stroke-linecap="round"{da} marker-end="url(#{m})" opacity=".92"/>'

zone = 'fill="none" stroke="#8893A1" stroke-width="3" stroke-dasharray="14 9"'

# ── building (north = left, east = top) ──────────────────────
BUILDING = [(540,430),(1040,430),(1040,365),(1140,365),(1140,305),(1945,305),(1945,945),(1480,945),(1480,1060),(600,1060),(600,985),(540,985)]
p(f'<polygon points="{" ".join(f"{x},{y}" for x, y in BUILDING)}" fill="#F4F6F9" stroke="{INK}" stroke-width="10" stroke-linejoin="miter"/>')

# Office (with its rooms)
p(f'<rect x="425" y="595" width="115" height="175" fill="#E3E8EF" stroke="{INK}" stroke-width="8"/>')
for ly in (650, 710): p(f'<line x1="425" y1="{ly}" x2="540" y2="{ly}" stroke="#9AA4B2" stroke-width="3"/>')
p(text(482, 690, 'OFFICE', 24, 800))

# Zones and labelled areas
p(f'<rect x="618" y="610" width="77" height="370" {zone}/>')
p(text(656, 795, 'CNC AREA', 26, 700, GREY, extra='transform="rotate(-90 656 795)"'))
p(f'<rect x="715" y="590" width="220" height="380" {zone} fill="#EEF1F5"/>')
p(text(825, 780, 'STORAGE\nRACK', 30, 700, GREY))
p(text(1085, 1005, 'MANUAL CUT AREA', 26, 700, GREY))
p(f'<rect x="985" y="575" width="445" height="92" {zone} fill="#EEF1F5"/>')
p(text(1207, 632, 'MODS ASSEMBLY AREA', 30, 800, GREY))
p(f'<rect x="1130" y="700" width="275" height="110" {zone} fill="#EEF1F5"/>')
p(text(1267, 763, 'V4T ASSEMBLY AREA', 28, 800, GREY))
p(text(1165, 395, 'RAW MATERIAL\n(PANEL) CUTTING AREA', 19, 700, GREY))
p(text(1700, 390, 'PANEL PLANT', 34, 800, GREY))
p(f'<line x1="1520" y1="430" x2="1520" y2="540" stroke="#8893A1" stroke-width="3"/>')

# Compressor room, washrooms (tornado shelter), gas main
p(f'<rect x="915" y="430" width="78" height="50" fill="#EDEFF3" stroke="#555" stroke-width="5"/>')
p(text(990, 392, 'COMPRESSOR\nROOM', 17, 700, GREY))
p(f'<rect x="705" y="436" width="40" height="52" fill="#fff" stroke="{BLUE}" stroke-width="5"/><rect x="745" y="436" width="40" height="52" fill="#fff" stroke="{BLUE}" stroke-width="5"/>')
p(text(725, 472, 'M', 28, 800, BLUE)); p(text(765, 472, 'F', 28, 800, BLUE))
p(text(795, 458, 'SHELTER AREA\n(WASHROOMS)', 15, 800, BLUE, 'start'))
p(f'<line x1="300" y1="490" x2="470" y2="490" stroke="{YEL}" stroke-width="9" stroke-dasharray="14 8"/>')
p(f'<polygon points="495,462 523,490 495,518 467,490" fill="{YEL}" stroke="{INK}" stroke-width="4"/>')
p(f'<path d="M 495 476 C 504 486 506 492 495 504 C 485 494 486 486 495 476 Z" fill="{INK}"/>')
p(text(385, 458, 'NATURAL GAS MAIN\n(AMEREN MISSOURI)', 16, 800, '#8A6606'))

# Handwritten changes
p(text(790, 366, 'EMPLOYEE ENTRANCE\n& SMOKING AREA', 20, 800, INK))
p(f'<rect x="488" y="1070" width="36" height="26" rx="3" fill="#C9D1DB" stroke="{INK}" stroke-width="3"/><line x1="506" y1="1070" x2="506" y2="1096" stroke="{INK}" stroke-width="2"/><rect x="520" y="1062" width="6" height="12" fill="{RED}"/>')
p(text(506, 1124, 'MAILBOX', 18, 700, GREY))

# Right-hand features
p(f'<rect x="1470" y="440" width="0" height="0"/>')
p(text(1690, 1000, 'OVERHEAD\nDOOR', 16, 700, '#8A6606'))
p(text(1530, 998, 'DOCKS', 18, 700, '#8A6606'))
p(eyewash(1530, 580)); p(text(1590, 586, 'EYEWASH', 17, 800, BLUE))

# Doors: man doors are exits (numbered); overhead / dock doors are not
EXITS = [  # n, x, y, rot, badge dx, dy
    (1, 660, 430, 0, 0, -58),
    (2, 570, 985, 180, 52, 38),
    (3, 1280, 305, 0, 0, -58),
    (4, 1905, 305, 0, 0, -58),
    (5, 1600, 945, 180, 0, 58),
    (6, 425, 680, 270, -58, 0),
    (7, 490, 595, 0, 0, -50),
]
for n, x, y, rot, dx, dy in EXITS:
    p(man_door(x, y, rot)); p(badge(x + dx, y + dy, n))
p(man_door(540, 735, 90, BLUE))                       # office -> plant
p(text(598, 742, 'to plant', 13, 700, BLUE))
p(man_door(725, 488, 180, BLUE, 30)); p(man_door(765, 488, 180, BLUE, 30))  # washroom doors
p(man_door(1470, 600, 270, BLUE, 30))                 # eyewash washroom? (drawn open to the aisle)
p(overhead(590, 430, 0, 90)); p(overhead(1325, 305, 0, 60))
for x in (1495, 1530, 1565): p(overhead(x, 945, 180, 28))
p(overhead(1685, 945, 180, 70))
p(text(604, 470, 'OVERHEAD DOOR\n(not an exit)', 13, 700, '#8A6606'))
p(text(1335, 352, 'OVERHEAD DOOR\n(not an exit)', 13, 700, '#8A6606'))

# Routes
for r in [
    [(660, 410), (660, 390), (150, 390), (150, 900)],       # exit 1 -> assembly
    [(415, 680), (210, 680), (210, 900)],                    # exit 6
    [(490, 570), (490, 585), (265, 585), (265, 900)],        # exit 7
    [(570, 1015), (570, 1030), (345, 1030)],                 # exit 2 -> assembly (west side)
]: p(route(r))
p(route([(1320, 215), (1120, 215)]))                         # exit 3 -> north along the outside
p(route([(1900, 215), (1740, 215)]))                         # exit 4
p(text(1130, 188, 'PROCEED TO ASSEMBLY POINT', 20, 800, GREEN, 'middle'))
# inside: you are here -> exit 1 and exit 3
p(route([(1465, 590), (1465, 560), (660, 560), (660, 455)], GREEN, width=6))
p(route([(1465, 530), (1465, 455), (1270, 455), (1270, 325)], GREEN, width=6))
# dock side -> assembly point the long way (orange)
p(route([(1480, 650), (1600, 650), (1600, 915)], ORANGE, True))
p(route([(1600, 1010), (1600, 1100), (1380, 1100)], ORANGE, True))
p(text(1180, 1104, 'PROCEED TO ASSEMBLY POINT', 20, 800, ORANGE))

# You are here
p(f'<circle cx="1465" cy="560" r="28" fill="#fff" stroke="{GREEN}" stroke-width="5"/>')
p(f'<circle cx="1465" cy="550" r="7" fill="{GREEN}"/><path d="M 1457 560 h 16 v 16 h -4 v 10 h -8 v -10 h -4 z" fill="{GREEN}"/>')
p(text(1465, 608, 'YOU ARE HERE', 17, 800, GREEN))

# First aid kits (FA) and a second eyewash by the office
p(first_aid(600, 862)); p(first_aid(870, 522)); p(first_aid(1540, 515))
p(eyewash(590, 640))
# Fire extinguishers — 17
FIRE = [(575,795),(558,652),(660,1022),(625,525),(1215,335),(1023,450),(1245,340),(1118,792),(1418,717),(1527,640),
        (1724,920),(1890,600),(1895,355),(760,990),(1300,990),(1750,620),(1800,430)]
assert len(FIRE) == 17
for x, y in FIRE: p(extinguisher(x, y))

# Muster point (main) and alternate point
p(f'<rect x="110" y="910" width="230" height="230" rx="26" fill="#E3F2E8" stroke="{GREEN}" stroke-width="5" stroke-dasharray="16 10"/>')
for i in range(6):
    for j in range(2): p(f'<circle cx="{145+i*32}" cy="{945+j*30}" r="9" fill="{GREEN}" opacity=".5"/>')
p(text(225, 1065, 'MUSTER\nPOINT', 34, 800, GREEN, 'middle'))
p(f'<rect x="70" y="225" width="260" height="200" rx="22" fill="#FFF6DA" stroke="{ORANGE}" stroke-width="5" stroke-dasharray="16 10"/>')
p(text(200, 305, 'ALTERNATE\nPOINT', 34, 800, ORANGE))
p(text(200, 380, '(assembly)', 18, 700, ORANGE))

# Compass: north is the left (office) end
p(f'<circle cx="1850" cy="1065" r="52" fill="#fff" stroke="{INK}" stroke-width="4"/>')
p(f'<path d="M 1805 1065 L 1850 1048 L 1850 1082 Z" fill="{INK}"/><path d="M 1895 1065 L 1850 1048 L 1850 1082 Z" fill="#fff" stroke="{INK}" stroke-width="3"/>')
p(text(1778, 1073, 'N', 28, 800)); p(text(1922, 1073, 'S', 24, 700)); p(text(1850, 1000, 'E', 24, 700)); p(text(1850, 1140, 'W', 24, 700))
p(text(1995, 1128, 'SCHEMATIC.\nNOT TO SCALE', 16, 700, GREY, 'end'))

PLAN = '\n'.join(plan)

# ── the poster ───────────────────────────────────────────────
S = 0.62
TX, TY = 1.6, 34
KEY = [(1, 'NORTHEAST CORNER MAN DOOR', 'employee entrance'), (2, 'NORTHWEST CORNER MAN DOOR', ''), (3, 'EAST WALL MAN DOOR', ''),
       (4, 'SOUTHEAST CORNER MAN DOOR', ''), (5, 'SOUTHWEST MAN DOOR (DOCKS)', ''), (6, 'OFFICE NORTH DOOR', ''), (7, 'OFFICE EAST DOOR', '')]
key = ''
for i, (n, name, note) in enumerate(KEY):
    y = 60 + i * 35
    key += f'<g transform="translate(22 {y})"><rect width="30" height="30" rx="5" fill="{GREEN}"/><text x="15" y="23" font-size="21" font-weight="800" fill="#fff" text-anchor="middle">{n}</text><text x="42" y="22" font-size="14" font-weight="700" fill="{INK}">{name}</text></g>'

legend_items = [
    (f'<circle cx="15" cy="15" r="13" fill="{RED}"/><text x="15" y="21" font-size="16" font-weight="800" fill="#fff" text-anchor="middle">F</text>', 'Fire extinguisher (17)'),
    (f'<rect x="1" y="1" width="28" height="28" rx="4" fill="#fff" stroke="{GREEN}" stroke-width="3"/><path d="M 11 6 h8 v6 h6 v8 h-6 v6 h-8 v-6 h-6 v-8 h6 z" fill="{GREEN}"/>', 'First aid kit (FA)'),
    (f'<circle cx="15" cy="15" r="13" fill="{BLUE}"/><text x="15" y="20" font-size="11" font-weight="800" fill="#fff" text-anchor="middle">EW</text>', 'Eyewash station'),
    (f'<rect x="1" y="5" width="28" height="20" fill="#fff" stroke="{BLUE}" stroke-width="3"/>', 'Shelter area (washrooms)'),
    (f'<rect x="0" y="9" width="30" height="12" fill="#FFE08A" stroke="#C9950A" stroke-width="2.5" stroke-dasharray="7 4"/>', 'Overhead / dock door (not exit)'),
    (f'<rect x="1" y="1" width="28" height="28" rx="6" fill="{YEL}" transform="rotate(45 15 15) scale(.75) translate(5 5)"/>', 'Natural gas main'),
    ('<path d="M 0 15 L 24 15" stroke="%s" stroke-width="6" marker-end="url(#ah)"/>' % GREEN, 'Route to assembly point'),
    ('<path d="M 0 15 L 24 15" stroke="%s" stroke-width="6" stroke-dasharray="7 5" marker-end="url(#ahy)"/>' % ORANGE, 'Dock-side route'),
]
leg = ''
for i, (icon, label) in enumerate(legend_items):
    y = 56 + i * 33
    leg += f'<g transform="translate(22 {y})">{icon}<text x="44" y="21" font-size="14.5" font-weight="600" fill="{INK}">{label}</text></g>'

def box(x, w, title, tcolor, body, fill='#fff', border='#C9CED6'):
    return f'<g transform="translate({x} 780)"><rect width="{w}" height="270" rx="14" fill="{fill}" stroke="{border}" stroke-width="2.5"/><text x="18" y="40" font-size="19" font-weight="800" fill="{tcolor}">{title}</text>{body}</g>'

def lines(items, x=18, y0=76, step=26, size=16, fill=INK):
    return ''.join(f'<text x="{x}" y="{y0 + i*step}" font-size="{size}" fill="{fill}">{t}</text>' for i, t in enumerate(items))

def steps(items, color, y0=82, gap=46):
    s = ''
    for i, (k, t) in enumerate(items):
        s += f'<text x="18" y="{y0 + i*gap + 6}" font-size="28" font-weight="800" fill="{color}">{k}</text>'
        for j, line in enumerate(t.split('\n')):
            s += f'<text x="50" y="{y0 + i*gap + j*18}" font-size="15" fill="{INK}">{line}</text>'
    return s

race = steps([('R', 'Remove people from the danger area.'),
              ('A', 'Alert people nearby, raise the alarm.\nDial 911: your name and location.'),
              ('C', 'Confine fire and smoke.\nClose doors behind you.'),
              ('E', 'Extinguish or evacuate. Fight a fire\nonly if trained and it is safe.')], RED)
pass_ = steps([('P', 'Pull the pin'), ('A', 'Aim at the base of the fire'), ('S', 'Squeeze the handle'), ('S', 'Sweep side to side')], RED, 84, 42)
tornado = lines(['Go to the SHELTER AREA', '(male / female washrooms).', '', '• Stay away from overhead doors', '   and docks', '• Close the washroom doors', '• Stay put until the all-clear'], 18, 76, 25, 16)
gas = lines(['• Leave the area at once', '• Do not use switches, phones or', '   flames inside the building', '• Call 911 from a safe distance', '• Go to the assembly point', '• Do not re-enter until cleared', '', 'Gas main: outside the north end'], 18, 76, 25, 15.5)
services = ('<text x="18" y="108" font-size="52" font-weight="800" fill="%s">DIAL 911</text>' % RED +
            lines(['Go to the MUSTER POINT (north-west', 'corner, outside). If it cannot be used,', 'go to the ALTERNATE POINT.', 'Stay for roll call. Do not re-enter', 'until you are told it is safe.'], 18, 142, 24, 15.5) +
            f'<text x="18" y="262" font-size="14" fill="{GREY}">Questions: Rizwan Khanjra · 519 778 7280</text>')

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
    <marker id="ah" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="3" markerHeight="3" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="{GREEN}"/></marker>
    <marker id="ahk" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="3" markerHeight="3" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="{INK}"/></marker>
    <marker id="ahy" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="3" markerHeight="3" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="{ORANGE}"/></marker>
  </defs>
  <rect width="1700" height="1100" fill="#fff"/>
  <rect x="0" y="0" width="1700" height="108" fill="#26272A"/>
  <rect x="0" y="100" width="1700" height="8" fill="{YEL}"/>
  <circle cx="68" cy="52" r="34" fill="{YEL}"/><path d="M 40 70 L 58 38 L 68 52 L 78 40 L 96 70 Z" fill="#26272A"/>
  <text x="122" y="64" font-size="40" font-weight="800" fill="#fff" letter-spacing="3">SUNSPACE</text>
  <text x="1670" y="62" font-size="54" font-weight="800" fill="#fff" text-anchor="end" letter-spacing="1">EMERGENCY EVACUATION PLAN</text>
  <text x="1670" y="92" font-size="19" fill="#E5E5E5" text-anchor="end">Sunspace USA INC · 1402 E Veterans Memorial Pkwy, Truesdale, MO 63380</text>
  <rect x="30" y="128" width="1310" height="632" rx="14" fill="#fff" stroke="#C9CED6" stroke-width="2.5"/>
  <g transform="translate({TX} {TY}) scale({S})" font-family="Liberation Sans, Arial, sans-serif">
{PLAN}
  </g>
  <!-- right column: exit key + legend -->
  <g transform="translate(1360 128)"><rect width="310" height="300" rx="14" fill="#fff" stroke="#C9CED6" stroke-width="2.5"/>
    <text x="22" y="40" font-size="22" font-weight="800" fill="{INK}" letter-spacing="1">EXIT KEY</text>{key}</g>
  <g transform="translate(1360 438)"><rect width="310" height="322" rx="14" fill="#fff" stroke="#C9CED6" stroke-width="2.5"/>
    <text x="22" y="36" font-size="22" font-weight="800" fill="{INK}" letter-spacing="1">LEGEND</text>{leg}</g>
  {box(30, 308, 'IF THERE IS A FIRE: R.A.C.E.', RED, race)}
  {box(363, 308, 'EXTINGUISHER GUIDE', RED, pass_)}
  {box(696, 308, 'TORNADO WARNING', PURPLE, tornado)}
  {box(1029, 308, 'NATURAL GAS LEAK', '#8A6606', gas, '#FFF8E1', YEL)}
  {box(1362, 308, 'EMERGENCY SERVICES', RED, services)}
  <text x="30" y="1082" font-size="15" fill="{GREY}">Reviewed by: ______________________   Date: ______________   Post at every exit and by the time clock.</text>
</svg></body></html>'''
html = html.replace('url(#ahy)', 'url(#ahy)')
open('evacuation-plan.html', 'w').write(html)
print('wrote evacuation-plan.html', len(html), 'bytes')
