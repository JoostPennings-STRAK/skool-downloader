# Taak: Video downloaden uit een Skool community post/thread

## Context
Dit is een fork van `balmasi/skool-downloader` (TypeScript, Node 18+, Playwright).
De tool kan nu alleen video's downloaden uit **classroom-lessen** (cursussen/modules).
Ik wil er ook video's mee kunnen downloaden die iemand als los bericht plaatst in een
**community post/thread** (dus niet in de classroom, maar in de discussie-feed van een
Skool-community). Doel: elke week (12 weken lang) een video uit een specifieke thread
downloaden.

## Relevante bestaande code
- `src/scraper.ts` — bevat de `Scraper`-class:
  - `parseClassroom(url)` en `extractLessonData(url)` lezen `__NEXT_DATA__` op de pagina
    en lopen door `pageProps.course` (de cursusboomstructuur) om lesdata + videolink te
    vinden. **Deze structuur is classroom-specifiek en dus niet herbruikbaar voor posts.**
  - De native Mux-video-detectie binnen `extractLessonData` (play-knop klikken op
    `div[class*="MuxThumbnailWrapper"]`, dan pollen op `performance.getEntriesByType('resource')`
    voor een m3u8-URL met token, met een shadow-DOM fallback voor `<video>`-elementen) is
    **wél generieke pagina-interactie** en zou herbruikbaar moeten zijn voor een post-pagina,
    ervan uitgaande dat Skool dezelfde Mux-player op posts gebruikt.
  - `metadata.videoLink` / `foundLesson?.video?.url` dekt kennelijk ook niet-native
    embeds (Loom/Vimeo/Wistia/YouTube) — check of een community post die op eenzelfde
    manier in zijn eigen metadata heeft staan.
- `src/auth.ts` — login-flow, sessie wordt lokaal opgeslagen in `.auth/storage_state.json`.
  Die login is al gedaan; hergebruik die sessie, vraag niet opnieuw om in te loggen.
- `src/downloader.ts` — bestaande download/opslaglogica (bestandsnaam-sanitizing, mapstructuur,
  index.html-generatie). Hergebruik dit waar mogelijk voor consistente output.
- `src/cli.ts` — huidige CLI-entrypoints/menu.

## Stap 1 — Verken de datastructuur van een post-pagina (doe dit eerst, voordat je code schrijft)
Schrijf een klein, wegwerpbaar inspectie-scriptje (mag los staan, hoeft niet netjes) dat:
1. Playwright chromium headless start met de bestaande `storageState` uit
   `src/auth.ts` (`STORAGE_STATE_PATH`).
2. Navigeert naar een door mij aan te leveren post-URL (vraag mij om een voorbeeld-URL
   als je die nog niet hebt).
3. `__NEXT_DATA__` uit de pagina haalt (zelfde patroon als in `scraper.ts`:
   `document.getElementById('__NEXT_DATA__')`).
4. De relevante subboom (waarschijnlijk `props.pageProps.post` of iets vergelijkbaars,
   niet `pageProps.course`) wegschrijft naar een lokaal JSON-bestand zodat we 'm kunnen
   inspecteren.

Rapporteer daarna kort welke velden relevant zijn voor: post-titel, videobron
(native Mux videoId, of een directe link naar Loom/Vimeo/Wistia/YouTube), en eventuele
bijlagen — voordat je verder bouwt op aannames.

## Stap 2 — Implementeer `extractPostData(url)` in `scraper.ts`
- Zelfde patroon als `extractLessonData`, maar dan gebaseerd op de daadwerkelijke
  post-datastructuur uit stap 1.
- Hergebruik de Mux-detectielogica (idealiter geëxtraheerd naar een private helper-methode
  zodat 'm door zowel `extractLessonData` als `extractPostData` aangeroepen kan worden,
  in plaats van te kopiëren-plakken).
- Geef een vergelijkbaar `Lesson`-achtig resultaat terug (titel, videoLink, evt. resources),
  of een nieuw `Post`-interface als de velden te veel afwijken.

## Stap 3 — CLI-integratie
- Detecteer in `cli.ts` (of een nieuwe kleine helper) of een meegegeven URL een
  classroom/les-URL is (bevat `/classroom`) of een community-post-URL, en routeer naar
  de juiste scraper-functie.
- Voeg zo nodig een expliciete subcommand toe, bv. `npm run skool post <url>`, als
  automatische detectie niet betrouwbaar genoeg is.

## Stap 4 — Download & opslag
- Gebruik de bestaande downloadlogica uit `downloader.ts` om de video weg te schrijven.
- Kies een logische output-locatie, bijvoorbeeld `downloads/<Community Name>/Posts/<post-titel>/video.mp4`,
  naast de bestaande `downloads/<Community>/<Course>/...`-structuur voor cursussen — niet
  door elkaar heen.

## Acceptatiecriteria
- `npm run skool <post-url>` (of het gekozen subcommand) downloadt de video uit die
  specifieke thread naar een duidelijke map, zonder dat de bestaande classroom-functionaliteit
  breekt.
- Bestaande sessie uit `.auth/` wordt hergebruikt, geen nieuwe login-flow nodig.
- Als de video een niet-Mux embed blijkt (Loom/Vimeo/Wistia/YouTube), moet dat ook werken —
  check of `yt-dlp-wrap` (al een dependency) die bron direct aankan, anders het directe
  media-URL doorgeven aan `yt-dlp`.

## Niet doen
- Geen wijzigingen aan de classroom/cursus-downloadflow an sich — die moet blijven werken
  zoals hij nu werkt.
- Geen `npm audit fix` of dependency-upgrades als onderdeel van deze taak, tenzij expliciet nodig
  voor iets in deze feature.
