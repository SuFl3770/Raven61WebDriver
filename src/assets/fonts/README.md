# Vendored fonts

## Cafe24 Lovingu

Used for the top bar's wordmark, and nothing else — see the `@font-face` at the
top of `src/styles.css`.

- Foundry: Cafe24 — <https://fonts.cafe24.com/>
- File taken from the `fonts-archive` mirror, which repackages the foundry's
  own release as web formats:
  <https://cdn.jsdelivr.net/gh/fonts-archive/Cafe24Lovingu/Cafe24Lovingu.woff2>
- Licence: free for personal and commercial use, redistribution included, per
  the foundry's terms on the page above. Selling the font file itself is not.

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
