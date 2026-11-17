# Roadbook conventions: our own summary

These notes are a short summary, **in our own words**, of the public roadbook
lexicons listed in [`SOURCES.md`](SOURCES.md). They explain the conventions our
stage builder, roadbook editor and in-game Roadbook app try to follow. They are
not a copy of any lexicon, they leave a lot out, and they are not official. If a
detail matters (for a real event), read the original document.

Short tags in brackets show where each point comes from:
**[FIA]** FIA lexicon 5.14 (2026), **[FIM]** FIM 2026 rally-raid symbols page,
**[ASO]** ASO / Dakar roadbook lexicon v3, **[DK21]** Dakar 2021 lexicon.

## 1. How one roadbook line is laid out [ASO]

Each line ("box") reads left to right:

- **Left cell:** the running total distance for the special stage at this point,
  and underneath it the partial distance since the previous box. A waypoint icon
  can sit in this cell too.
- **Middle cell (the tulip):** a small top-down drawing of the junction or
  feature. You enter from the bottom; the arrow shows the way out.
- **Right cell:** notes about what happens *after* this point (hazards, heading,
  speed limit, surface).

The page header gives the leg number and name and the stage's total length.

## 2. Track and surface lines in the tulip [FIA] [FIM]

The drawing style of a line tells you what kind of way it is. Roughly, from
biggest to faintest: a paved road is drawn as an open double line, a main track
as a thick solid line, a smaller track as a thinner solid line, faint traces as
a dash-dot line, and driving across open country with no track (off-piste, "HP")
as a dotted line. The lexicons also have marks for a parallel track, a track to
keep following, and areas where leaving the track is banned.

Our renderer uses the same idea: see `TRACK_NAMES` and the line `STYLE` table in
`stage-builder/roadbook-render.js`.

## 3. Danger levels [FIA] [ASO]

- Three levels, written as one, two or three exclamation marks, in red.
- Level 2 also gets a red underline under the total distance.
- Level 3 puts a red frame round the whole line, and the box before it carries a
  red down-arrow as a warning that it is coming.
- If the danger mark itself is framed, the danger covers the whole box, not just
  one spot.
- When a danger falls on the first line of a new page, the previous page's foot
  repeats it so you are not caught out by a page turn.

## 4. Colours and special zones [ASO]

- **Waypoints:** the left cell is tinted with a colour for the waypoint type,
  and the right cell shows the waypoint's number in a circle.
- **Short gaps:** if the partial distance is very short (a few hundred metres),
  the left cell is tinted and the box before it carries a small arrow, so you
  are ready for two notes in quick succession.
- **Speed zones:** an orange frame runs from the zone-start box ("DZ") to the
  zone-end box ("FZ"). The limit is shown as a number in an orange circle; at the
  end it is crossed out.
- **Passage controls (CP)** sit inside a speed zone and are marked in purple.
- **Transfers and neutralised sections** have separate IN and OUT boxes, framed
  in yellow, with a clock symbol and the allowed time.
- **Headings** are shown as black numbers on a yellow patch, sometimes with a
  distance to hold that heading for.
- **Which way to go:** where a tulip has several junctions, the way to take may
  be drawn in a highlight colour and the others left in black.
- **Later edits:** after the opening car has run, boxes that were changed or
  added are flagged so competitors can spot them.

## 5. Kinds of symbols [FIA] [FIM] [DK21]

The lexicons group their symbols roughly like this. We list only the groups
and a few examples, not the full sets.

| Group | What it covers (examples) |
| --- | --- |
| On-track features | bumps, dips, ditches, crests, steps up or down, steep climbs or drops, bridges |
| Safety | the three danger levels, stop, speed limit, zones where overtaking is hard |
| Dunes and sand | single or many dunes, broken dunes, sandy flats, bowls |
| Waypoints | visible, hidden / masked, safety, navigation and control waypoints |
| Headings ("caps") | a heading to take on exit, an average or a varying heading |
| Landmarks | fences and gates, rail lines, power lines and pylons, wells, ruins, villages, trees, cairns, wadis of different sizes |
| Controls | start and finish of the special stage, checkpoints, neutralisation and transfer starts / ends, fuel and service zones |
| Abbreviations | short written words (left / right, keep left, narrow, many, rejoin, and so on) |

The FIA document says only its listed symbols may be used in FIA events, and
that extra symbols need FIA approval. Our set is a **small, unofficial subset**
drawn from scratch for a game; it is not FIA- or FIM-approved artwork.

## 6. How our set differs

- We draw only the symbols a BeamNG.Earth stage can use: track types, junctions,
  danger levels, speed zones, waypoints, a handful of landmarks taken from real
  OpenStreetMap data, and some abbreviations.
- Landmarks are added only when OpenStreetMap has them; we never invent one.
- A tulip may show more than one junction when two are close together.
- Gaps between boxes aim for roughly 2 to 8 km, closer near tricky sections.
- Notes are typed in the editor only.

See `stage-builder/roadbook-render.js` (`GROUPS`, `ABBR`, `NAMES`) for the exact list.
