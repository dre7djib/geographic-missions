# Geographic Missions

A mission system for **Subway Builder** with objectives tied to real places. Connect La Défense to Châtelet, serve a tour of Paris landmarks, carry commuters from the suburbs to the business district, and get paid for it.

Missions are shown in an in-game panel, highlighted on the map when you click them, and confirmed by a pop-up when you complete them. Progress is saved per game.

> **Status:** early version (0.1.0). Feedback and bug reports are welcome.

## Features

- **A mission panel** (book icon) with two collapsible drawers: *General Missions* and the missions of the city you are playing.
- **Zones on the map.** Click a mission to draw its zones, with name labels, and recenter the map on them. Click it again to hide them.
  - Blue is the starting zone and orange the destination of a link, joined by a dashed line.
  - Green marks the zones of a station, ridership or tour mission.
- **A completion pop-up** with the mission, the day and the reward. Several missions completed at once are shown one after another. It follows the game's light or dark theme.
- **Money rewards**, scaled per city (see [Rewards](#rewards)).
- **Native career missions** with real origin → destination passenger flows (see [Career missions](#career-missions)).
- **Fast confirmation.** Missions are checked every 2 seconds and right after you build a station or a line, even when the game is paused.
- **Progress saved per game.**



## Missions



### General missions (every city)


| Mission           | Objective                                                       |
| ----------------- | --------------------------------------------------------------- |
| First Line        | Create a metro line and get trains running on it                |
| Build the Network | 10 stations, each on a line with trains running                 |
| Transfers         | 3 built stations in a transfer hub, served by lines with trains |
| First Riders      | Reach 1,000 riders per hour on the network                      |
| Mode Shift        | 10% of home-to-work trips by public transit                     |
| In the Black      | A positive profit over 24 h, with at least one line             |
| Survive a Month   | 30 distinct game days with trains running                       |




### City missions


| City                      | Missions                                                                                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Paris / Île-de-France** | From the Grande Arche to Les Halles · Heading to Orly · Roissy Express · Night at the Stade de France · Heading to Disneyland · The Saclay Plateau · Europe's Biggest Hub · Tour of Paris |
| **Lyon**                  | Part-Dieu – Bellecour · La Doua Campus · Heading to Saint-Exupéry · The Business Heart · Tour of Lyon                                                                                     |
| **Marseille**             | From the Station to the Old Port · Night at the Vélodrome · Marseille Provence · Aix-Marseille · Tour of Marseille                                                                        |
| **New York**              | A Foothold in Bushwick · Bushwick Express · Wall Street Never Sleeps · Heading to JFK · Heading to LaGuardia · Tour of the City                                                           |
| **London**                | City – Canary Wharf · Heathrow Express · Heading East · The Business District · Tour of London                                                                                            |


The city is detected automatically. In a city without a pack, only the general missions appear.

**Tour missions** ask you to serve six zones: three districts and three landmarks.


| Tour      | Districts                                       | Landmarks                                                    |
| --------- | ----------------------------------------------- | ------------------------------------------------------------ |
| Paris     | La Défense, Châtelet – Les Halles, Gare du Nord | Eiffel Tower, Arc de Triomphe, Notre-Dame                    |
| Lyon      | Part-Dieu, Bellecour, La Doua                   | Fourvière Basilica, Place des Terreaux, Parc de la Tête d'Or |
| Marseille | Saint-Charles, Old Port, Stade Vélodrome        | Notre-Dame de la Garde, La Major Cathedral, Palais Longchamp |
| New York  | Bushwick, Lower Manhattan, Downtown Brooklyn    | Empire State Building, Times Square, Central Park            |
| London    | Canary Wharf, The City, Stratford               | Big Ben, Buckingham Palace, British Museum                   |




### What "built and served" means

A mission only counts what is really running, not what is only planned:

- A station counts only once it is **constructed**. Blueprints and previews are ignored.
- A station is **in service** when it is on a line that currently has at least one train.
- **Link missions** need a built, in-service station in both zones, and a **single line with trains** serving both.
- **Tour missions** need an in-service station in each of the six zones.

The panel tells you what is missing, for example:

```
7 / 10 stations in service · 2 built, no train yet · 1 not built yet
La Défense: in service ✓ · Châtelet – Les Halles: built, no train yet
```



## Rewards

Rewards are added to your budget. They are scaled per city, because a line easily costs over $1 billion and the normal-mode starting budget is $3 billion.


| City                  | Factor | Per mission  | Full city (general + city missions) |
| --------------------- | ------ | ------------ | ----------------------------------- |
| Paris / Île-de-France | ×50    | $50M – $400M | ≈ $3.05B                            |
| New York              | ×50    | $50M – $400M | ≈ $2.5B                             |
| London                | ×50    | $50M – $400M | ≈ $2.1B                             |
| Marseille             | ×25    | $25M – $200M | ≈ $1.1B                             |
| Lyon                  | ×25    | $25M – $175M | ≈ $1.05B                            |
| Other cities          | ×50    | $50M – $250M | ≈ $1B (general missions only)       |


Completing everything in a city roughly doubles the normal-mode starting budget in the larger cities. To make the game harder, lower the `rewardScale` of a city (see [Customizing](#customizing)).

## Career missions

On top of the panel, the mod registers five missions with the game's native career system (`api.career`). They track **real passenger flows from one zone to another**.


| City      | Mission                       |
| --------- | ----------------------------- |
| Paris     | Northern Suburbs → La Défense |
| Paris     | Marne-la-Vallée → Châtelet    |
| Lyon      | La Soie → Part-Dieu           |
| Marseille | Aix → Saint-Charles           |
| London    | Stratford → Canary Wharf      |


Each has three stars: **2 stations** in the origin zone, then **1,000** and **5,000 passengers** from the origin to the destination. They follow the game's own tracking rules and have no money reward. If `api.career` is not available in your game version, they are skipped and everything else still works.

## Installation



### With Railyard

Search for **Geographic Missions** in [Railyard](https://subwaybuildermodded.com/railyard/) and install it.

### Manually

1. Download the latest release and extract it so that `manifest.json` and `index.js` are directly inside a `geographic-missions` folder in your mods directory:
  - Windows: `%APPDATA%\metro-maker4\mods\`
  - macOS: `~/Library/Application Support/metro-maker4/mods/`
  - Linux: `~/.config/metro-maker4/mods/`
2. Start the game and enable **Geographic Missions** in *Settings → Mods*.
3. Start or load a game, then open the mission panel from the book icon.

To reload the mod without restarting, run this in the game console:

```js
await window.SubwayBuilderAPI.reloadMods();
```



### Requirements

- Subway Builder **desktop version**, with mods enabled.
- A game version that includes the cities you want to play. Paris, Lyon and Marseille were added in game version 1.6.0.



## Notes and limitations

- **Zones are approximate rectangles**, not exact district borders. A station near the edge of a landmark may not count, or may count a little too generously.
- **"In service" means a train is running right now.** If a line withdraws its trains off-peak, a zone can briefly show "no train yet". A mission that was already completed stays completed.
- **Survive a Month** counts days with trains running from the moment you start using the mod, so a game already well advanced starts at zero.
- Progress is stored per game session and does not carry over between different games.
- If the book icon is not available in your game version, the panel falls back to the train icon.



## Debugging

Two settings are available in the game's settings menu:

- **Missions: show station coordinates (debug)** shows the longitude and latitude of a station when you select it. Useful to calibrate zones.
- **Missions: reset (debug)** clears the completed missions of the current game.

You can also inspect the state of every mission from the console:

```js
window.__missionsGeoStatus()
```

It prints the detected city, whether the game is loaded, and a table with the progress of each mission.

## Customizing

All the content lives in the `PACKS` list at the top of `index.js`. Each city is a pack with:

- `cityCode`, the game's city code (`PAR`, `LYO`, `MAR`, `NYC`, `LON`).
- `rewardScale`, the reward factor.
- `bbox`, a bounding box used as a fallback to detect the city.
- `zones`, named rectangles written as `[west, south, east, north]` in degrees.
- `defs`, the missions, of four types: `stationsIn`, `connect`, `zoneRidership` and `coverage`.

To add a city, copy an existing pack and edit it. City codes are listed by `window.SubwayBuilderAPI.utils.getCities()`.

## Credits

Geographic career missions are inspired by *Bushwick Express* by EJ Fox. Built on the Subway Builder modding API.