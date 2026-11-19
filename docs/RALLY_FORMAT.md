# rally.raid Earth rally file, format v1 (EXPERIMENTAL)

A rally file describes a multi-day rally raid: the bivouacs, the days in order, each day's liaisons and the
special stage (SS) to drive. Each SS is an ordinary stage v1 file (docs/STAGE_FORMAT.md), with its roadbook
(docs/ROADBOOK_FORMAT.md) next to it. Rally files are made by `tools/rally-compile.js`; nobody needs to write one by hand.

## Files and folders

```
<folder>/<rallyId>.rally.json                          the rally file
<folder>/<rallyId>/stages/<stageId>.json               one stage file per SS (stage v1)
<folder>/<rallyId>/stages/<stageId>.roadbook.json      its roadbook (optional; the game finds it next to the stage)
```

Paths in the rally file (`stage.file`, `stage.roadbook`) are relative to the folder of the rally file.
The mod reads rallies from `/rallyraid/rallies/` (in the zip: `rallyraid/rallies/`); the website has them under `rallies/`.
File names, ids and titles never carry event or organiser marks (checked by the compiler).

## Top level

| key | type | meaning |
|---|---|---|
| `format` | `"rallyraid-rally"` | fixed |
| `schemaVersion` | `1` | fixed; readers refuse other versions |
| `id` | string `[a-z0-9-]` | rally id; also the progress file name in the game (`/rallyraid/rally/rally_<id>.json`) |
| `name`, `shortName` | string | public name, e.g. "Atlantic to Atlas 2027" |
| `season` | string | e.g. "2027" |
| `disclaimer` | string | exactly one line `Inspired by the <year> <...> route. Unofficial, not affiliated.` Shown on the page and in the game |
| `description`, `region` | string | |
| `startDate`, `endDate` | `YYYY-MM-DD` | |
| `experimental` | bool | `true` while rally mode is experimental |
| `generator`, `created` | string | tool and ISO time |
| `dataSource` | string | attribution (OSM ODbL, Mapterhorn, ESA WorldCover; where the route facts come from) |
| `source` | `{facts, notUsed}` | what was taken from published facts, and what is estimated or invented |
| `rules` | object | `liaison: {kmh, extraMin, roundMin}` used to compute allowances, plus plain-text rule notes. The game's live values are in `repairConfig.lua` (`M.rally`) |
| `bivouacs` | array | see below |
| `landmarks` | array | `{id, name, lat, lon, osm}`; only places that exist in OpenStreetMap (`osm` = `way/123`, `node/…`, `relation/…` or a Nominatim note) |
| `totals` | object | `days, stages, ssTargetKm, ssKm` (generated), `liaisonKm, publishedTotalKm` |
| `days` | array | in order, numbered 1..N |

### Bivouac

`{id, name, lat, lon, kind, country?, invented?}`. `kind`: `bivouac`, `rest`, `marathon` (refuge, no assistance), `port`.
`country` is left out where a country label would be political (Western Sahara stops: town names only).
`invented: true` marks a position that is not published (e.g. a marathon refuge).

### Day

| key | meaning |
|---|---|
| `n`, `date`, `code` | day number, date, short code (`P`, `SS1`, `T`, `REST`) |
| `type` | `stage`, `marathon`, `transfer` (liaison only), `rest` (no driving) |
| `title` | e.g. "SS4 Bouarfa - Zagora: Erg Chebbi" |
| `from`, `to` | bivouac ids; `from` must equal the day before's `to` |
| `marathon` | `true` exactly when `type` is `marathon` |
| `totalKm` | published total of the day (liaisons + SS) |
| `note` | optional |
| `liaisonOut` | `{km, allowanceMin, to: "dss" or a bivouac id, drive, ferry?, straightKm}`: bivouac to the stage start (or to the next bivouac on a transfer) |
| `liaisonIn` | `{km, allowanceMin, from: "ass", drive, straightKm}`: stage finish to the evening bivouac |
| `stage` | stage and marathon days only, see below |

`allowanceMin = ceil((km / kmh * 60 + extraMin) / roundMin) * roundMin` (defaults 60 km/h, 30 min, 5 min; 0 km gives 0).
`km` are the published (road) distances; `straightKm` is the straight line, for information.

### Stage

`{id, file, roadbook, targetKm, km, deviation, name, dss: {lat, lon}, ass: {lat, lon}, waypoints, boxes, parts, landmarks: [ids], preview}`.
`targetKm` is the published SS distance, `km` the generated one, `deviation = (km - targetKm) / targetKm` (goal within ±0.10).
`parts` is the number of chained Stage-Gen segments. `preview` is a light `[[lat, lon], …]` line (about one point per 1.5 km) for maps;
the game drives the stage file, not the preview.

## How the game uses it (rally mode, EXPERIMENTAL)

Phases per day: liaison out → stage → liaison in → bivouac → next day. On each liaison the player picks
**DRIVE** (the clock runs against `allowanceMin`; unused minutes go to the bivouac repair clock; late arrival costs
`latePenaltyPerMinS` per started minute) or **TELEPORT** (the full allowance is counted, no leftover).
Marathon days end at a refuge: small repair budget, no engine change, leftover not added (config `rally.marathon`).
A rest day adds `restDayBonusMin` to the open bivouac. Cumulative time = stage times + stage penalties + liaison time + liaison penalties.
All values: `mod/lua/ge/extensions/rallyRaid/repairConfig.lua`, section `M.rally`.

## Calendar file

`calendar.json` (`format: "rallyraid-calendar"`, `schemaVersion: 1`): `{id, season, name, description, experimental, rounds: [...]}`,
round = `{n, status: "ready" | "placeholder", name, region, start, end, rally?: "rallies/<id>.rally.json", disclaimer?, note?}`.

## Making a rally

1. Write an event spec (`rallies/specs/<id>.spec.json`): bivouacs, landmarks, days with published km, DSS / ASS / via points for each SS,
   generation settings (`seed`, `segMaxKm`, `ratio`, `avoid` polygons).
2. `node tools/rally-batch.js rallies/specs/<id>.spec.json` generates every SS with Stage-Gen, chaining segments for stages over
   about 185 km (stage-builder/stage-chain.js). It runs in the background, resumes (finished parts and stages are kept),
   retries, and writes `rallies/build/<id>/` (`logs/<stage>.log`, `run.log`, `report.json`). `--only SS4`, `--redo`, `--no-roadbook`.
3. `node tools/rally-compile.js rallies/specs/<id>.spec.json` checks everything and writes the rally file with its stages
   to `stage-builder/rallies/` and `mod/rallyraid/rallies/`.

