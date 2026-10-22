# The song database

A shared database of songs every church on Flockwise can search (Services › Song database) and
copy into its own song library in one click. Once copied, the song is the church's own: it can
change the key, add chords, a second language or an arrangement without touching the database.

## What is in it

- **Public-domain hymns from the [Open Hymnal Project](https://github.com/mzealey/openhymnal)**
  (263 English hymns with all their verses, credits, tune names and keys). Built by
  `scripts/import-open-hymnal.py`, which keeps only files whose copyright line says "public
  domain" and skips modern words. Re-run it to refresh `src/core/catalog/open-hymnal.ts`; never
  edit that file by hand.
  256 of them also carry a chord chart. The script works the chords out from the hymnal's
  four-part harmony (soprano, alto, tenor, bass): on each melody note it weighs the pitches
  sounding in all four voices, picks the best-fitting chord (major, minor, 7th, m7, sus4, dim, with
  the bass note as a tie-breaker) and writes it over that syllable when it changes. A hymn gets a
  chart only when every music line has exactly as many syllables as notes and the words come out
  identical to the plain lyrics, so a chord never lands on the wrong word.
- **Songs the Flockwise team adds** in the team panel (`/platform/songs`): hymns in Hindi, Telugu,
  Tamil, Malayalam, Kannada and other Indian languages from a checked hymnbook, and corrections to
  built-in hymns. Stored in the platform database (`meta` rows `song:<id>`), so no deploy is needed.

Anup's rule (2026-10-22): **the database holds public-domain songs only.** The team API refuses
anything else, and words need a `source` (hymnbook and edition, or website) so they can be checked.
Public domain in India means the writer (and translator) died more than 60 years ago; in the US,
published before 1930. When in doubt, leave it out.

## Team API (`/v1/platform/songs`, Flockwise team session)

| Method | Path | Body / result |
|---|---|---|
| GET | `/platform/songs?q=&lang=` | Up to 200 rows, `edited: true` for the team's own entries |
| GET | `/platform/songs/:id` | One song with words |
| POST | `/platform/songs` | New song: `{ title, aka[], language, writers, music?, year?, rights: "public-domain", defaultKey, bpm?, tune?, themes[], lyrics?, chordChart?, arrangement[], source }`. Id becomes `fw-<title>` |
| PUT | `/platform/songs/:id` | Replace a team song, or correct a built-in hymn |
| DELETE | `/platform/songs/:id` | Remove a team song, or undo a correction |

Words use the same format as the song library: a section heading on its own line (`Verse 1`,
`Chorus`), the lines, and a blank line between sections.

## Licensed lyrics feeds (the connector for later)

For songs whose words Flockwise may not ship itself, the server can ask licensed lyrics services
that Agape Labs has an agreement with: CCLI SongSelect's partner API, a publisher, or an Indian
music label. Each is one entry in the `LYRICS_FEEDS` environment variable. When a church that has
saved its CCLI licence number adds a song without words, the server asks each feed in turn:

```
POST <feed url>
Authorization: Bearer <feed key>
Content-Type: application/json

{ "catalogId": "…", "title": "…", "writers": "…", "ccli": "1234567" | null, "language": "en",
  "church": "<church id>", "licence": { "ccli": "<church CCLI licence no.>", "streaming": "…" | null } }
```

The feed answers `200 { "lyrics": "Verse 1\n…", "chordChart"?: "…", "copyright"?: "© …", "defaultKey"?: "G" }`
or `404` when it has no words or the church is not licensed for them. The song is saved with the
feed's copyright line and `licensedFrom` set to the feed's name. A feed with `"covers": "ccli"` is
only asked about songs that have a CCLI number. Plugging in SongSelect later means writing a small
adapter service that speaks this contract with SongSelect's own API, then adding it to
`LYRICS_FEEDS`; nothing in the church app changes.

Churches enter their CCLI licence numbers under Services › Song database › Licences. They are also
what the CCLI report and projected copyright lines should show.
