# Credits and data sources

This project (the stage builder at https://stagebuilder.wyans.net, the roadbook editor, and the rally.raid Earth mod for BeamNG.drive) is made for [BeamNG.Earth](https://github.com/tecnagamer/beamng.earth). It is not an official BeamNG, FIM or FIA product. BeamNG.drive is a trademark of BeamNG GmbH. BeamNG's own files and terms are unchanged.

The project's own code is offered under the MIT Licence in `LICENSE` (Copyright (c) 2026 wyans). The data and libraries below keep their own licences. If you share a stage or a roadbook built here, you must keep the OpenStreetMap credit, because that work is built from OSM data.

## OpenStreetMap

Roads, tracks, paths, places, landmarks, and any stage or roadbook generated from them.

- Credit: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors
- Licence: [Open Database Licence (ODbL)](https://opendatacommons.org/licenses/odbl/)

## Nominatim (place search and auto-generated names)

The public search service at nominatim.openstreetmap.org. Used when you search for a place, and when the builder fills a stage name and description from nearby place names.

- [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/): no more than one request a second, identify the app, show OSM attribution, cache where possible. Automatic name lookups are spaced at least 1.1 seconds apart. Do not use this service for autocomplete-as-you-type.

## OSRM (car routing)

"Roads (car routing)" legs are routed by the public OSRM demo server at router.project-osrm.org. That server is a courtesy, with no uptime promise; treat it as fair use (about one request a second).

## Overpass API (OpenStreetMap questions)

Used for "tracks & paths" legs, roadbook landmarks and junctions, and Stage-Gen. Queries go to public Overpass mirrors:

- [NextGIS](https://nextgis.com) Overpass (https://overpass.nextgis.com)
- https://overpass-api.de
- https://overpass.private.coffee
- https://maps.mail.ru/osm/tools/overpass/
- Regional extracts on https://ovp.dresel.systems and https://overpass.osm.ch (Switzerland)

The data they return is still OpenStreetMap data (ODbL). Please be gentle with these free servers: this project caches answers in the browser, spaces requests, and skips a server that is silent or full.

## ESA WorldCover (land cover / forest warnings)

Land cover for forest warnings and Stage-Gen.

- Product: ESA WorldCover 10 m 2021 v200
- Licence: [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/)
- Map attribution: © ESA WorldCover project / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium
- Citation: Zanaga, D., Van De Kerchove, R., Daems, D., De Keersmaecker, W., Brockmann, C., Kirches, G., Wevers, J., Cartus, O., Santoro, M., Fritz, S., Lesiv, M., Herold, M., Tsendbazar, N.E., Xu, P., Ramoino, F., Arino, O., 2022. ESA WorldCover 10 m 2021 v200. https://doi.org/10.5281/zenodo.7254221
- Tiles are fetched through the Microsoft Planetary Computer.

## Elevation (terrain notes, slopes, crests)

- Primary: [Mapterhorn](https://mapterhorn.com) terrain tiles, built from open digital elevation models. The global baseline is Copernicus GLO-30 (produced by DLR and Airbus, provided under Copernicus by the European Union and ESA). Regional sources and their licences are listed at https://mapterhorn.com/attribution
- Fallback: Mapzen / Tilezen Terrarium tiles hosted on AWS (`elevation-tiles-prod`). Attribution for those sources: https://github.com/tilezen/joerd/blob/master/docs/attribution.md

## Map tiles (the background map you see)

- OpenStreetMap standard tiles from tile.openstreetmap.org — © OpenStreetMap contributors. The [tile usage policy](https://operations.osmfoundation.org/policies/tiles/) applies (visible attribution, no bulk download).
- [OpenTopoMap](https://opentopomap.org) — © OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)
- Esri World Imagery — Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community

## Libraries

- [Leaflet](https://leafletjs.com) 1.9.4 (BSD-2-Clause), loaded from unpkg, for the maps
- [jsPDF](https://github.com/parallax/jsPDF) 2.5.1 (MIT), loaded from unpkg, for printable roadbooks
- [fflate](https://github.com/101arrowz/fflate) (MIT), used to pack share links
- The in-game apps use AngularJS as provided by BeamNG.drive (not bundled in the mod zip)

## Roadbook symbols and rules

Waypoint types, radii and penalties follow the public 2026 FIM World Rally-Raid Championship sporting regulations, which you can change per stage on the Rules tab. The symbols drawn in the editor and in the game are a compact, unofficial set made for this project in the style of the public FIM / FIA / Dakar lexicons. This is not official FIM or FIA artwork, and those organisations have not endorsed the project.

## BeamNG.Earth

The game world, the live latitude / longitude, and the roads you drive are from [BeamNG.Earth](https://github.com/tecnagamer/beamng.earth). This mod sits on top of it. You need BeamNG.Earth installed for the GPS and stages to make sense.
