# Vendored fonts

## SUIT

Used for the top bar's wordmark, and nothing else — see the `@font-face` at the
top of `src/styles.css`.

- Foundry: SUNN YOUN — <https://sunn.us/suit/>
- Licence: SIL Open Font License 1.1. Free to use, embed and redistribute;
  the licence travels with the files.
- Vendored from the family's own repository, the variable face (`wght`
  100–900), cut down to Basic Latin:

  ```
  curl -L -o SUIT-Variable.woff2 \
    "https://cdn.jsdelivr.net/gh/sun-typeface/SUIT@main/fonts/variable/woff2/SUIT-Variable.woff2"
  python -m fontTools.subset SUIT-Variable.woff2 \
    --unicodes="U+0020-007E" --flavor=woff2 \
    --output-file=SUIT-Variable-latin.woff2
  ```

  The wordmark is two Latin letters and the full family is 610 kB, nearly all
  of it Hangul that nothing here asks this family for — Hangul in the app is
  Noto Sans KR's job. The cut is 17 kB and keeps the whole weight axis.

Vendored rather than linked from a CDN so the app draws its own mark with no
network and on a `file://` build. Only the `woff2` is kept: the app is built on
WebHID, and no engine that ships WebHID lacks `woff2`.

## Noto Sans KR

The interface font — everything the app draws except the wordmark above and the
monospace runs (`--mono`, which stays a system stack).

- Foundry: Google — <https://fonts.google.com/noto/specimen/Noto+Sans+KR>
- Licence: SIL Open Font License 1.1. Free to use, embed and redistribute;
  the licence travels with the files.
- Vendored from Google Fonts, family version `v39`, as one variable face
  (weight 100–900) cut into the 124 unicode-range slices Google itself serves:

  ```
  curl -A "<a modern browser UA>" \
    "https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@100..900&display=swap"
  ```

  That stylesheet is what `../noto-sans-kr.css` is, with every URL pointed at
  `noto-sans-kr/` beside it. To refresh: fetch it again, download each `woff2`
  it names, and regenerate the local copy — the slice names here are the index
  in Google's own URLs (`…​.37.woff2` → `notosanskr-korean-37.woff2`), with the
  five non-Korean slices named after the comment labels in that file.

3.7 MB on disk, which is not what anyone downloads: each slice is declared for
the characters it covers, so a browser fetches only the few the text on screen
needs — a Korean UI pulls roughly a tenth of it, an English one far less.
