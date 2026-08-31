# ZeroLeak

Finds what a PDF is still carrying — text under redaction boxes, invisible text,
earlier revisions, embedded files, scripts, both metadata blocks, review
comments, content drawn outside the page — and strips it out. Everything runs in
the browser.

**<https://zeroleak.sehahub.info>**

---

## The claim, and how to check it

Your document is never uploaded, because there is no server-side code to upload
it to. The site is static files behind a Worker whose entire job is to serve
them and increment three counters.

Three ways to verify that without trusting anyone:

1. **Load the page, disconnect from the network, then scan and clean a file.**
   Both still work.
2. **Read [`src/worker.ts`](src/worker.ts).** It has three endpoints. None of
   them accepts a file.
3. **Run the tests.** `test/browser.test.mjs` drives a real browser through a
   scan and asserts that no request leaves the origin, that the only request
   body sent is literally `{"name":"scan"}`, and that nothing the page posts
   mentions the document.

What the site does record: a page was viewed (day and referring site), a scan
finished, a file was cleaned. The Worker checks event names against a fixed list
of three and the request carries no other field, so no property of a document
can reach it even by accident.

## How the detection works

`src/lib/scan-page.ts` walks pdf.js's operator list for each page, tracking the
graphics state — transform, clip, fill colour, alpha, blend mode, text matrix,
render mode — and builds a box for every text run and every opaque shape. Text
covered by a shape painted *after* it is text you cannot see but can still copy.

Most of the work is in not crying wolf. Synthetic fixtures produced a detector
that looked perfect and fell apart on real documents:

| What real PDFs do | What it looked like |
| --- | --- |
| A hairline rule drawn as a page-sized rectangle clipped to a sliver | A box covering the whole page. RFC 9110 alone produced 1016 false claims. |
| Annotation placement passed through `beginAnnotation`, not a transform op | Every annotation's contents measured at the page origin |
| Linearized files carrying two `%%EOF` markers by design | Clean documents accused of hiding earlier revisions |
| Scans and CAD exports carrying an invisible text layer on purpose | A standing critical alarm on exactly the documents this is for |
| A label drawn behind a shape and again on top of it | Hidden text, twice per diagram |
| Highlighter pens using Multiply blending | An opaque cover over readable text |
| Text set vertically, as Japanese and Chinese often are | Nothing at all — a redaction measured as though it ran to the right |

Each is now pinned by a fixture in `test/make-tricky.mjs`. Across 224 real
published documents — arXiv, the RFC Editor, the IRS, the SEC, the US
Government Publishing Office, the UN, the US Courts and 210 UK government
publications — the scanner produces no false positives.

Non-Latin scripts get their own checks, because CID-keyed fonts map glyphs to
characters differently and can run down the page rather than across it.
`test/corpus.mjs cjk` paints a black box over a line of a real Korean and a real
Chinese document the way a person would, and asserts the text comes back out; it
lives with the corpus tooling because it needs the fetched documents, whose
fonts belong to them rather than to this repository. Vertical writing is covered
by `test/fixtures/vertical.pdf`, hand-authored around an Identity-V encoding so
it needs no embedded font at all — pdf.js reports vertical metrics per glyph,
which is how the writing direction is known without reaching for the font.

## Cleaning

`src/lib/clean.ts` deletes metadata (both blocks), embedded files, scripts,
annotations and form fields, then sweeps the object graph and drops everything
no longer reachable — pdf-lib serialises orphaned objects, so unlinking alone
writes removed content straight back out. Saving rewrites the file as a single
revision, which is what discards retained earlier versions.

Hidden text is handled differently: **any page carrying it is replaced with a
flat image of itself.** Deleting individual text objects means calculating
exactly which ones a box covers, and an error there hands back a file that has
been declared safe while still carrying the words. Rasterising costs selectable
text on the affected pages and nothing else; the tests assert that no secret
survives in the output bytes.

## Research

`research/corpus.mjs` samples published PDFs and measures how often they leak.
The write-up is at
[/research/government-pdfs](https://zeroleak.sehahub.info/research/government-pdfs).

The pipeline records finding types and counts and nothing else — it has no field
for recovered text, metadata values or page images. Only aggregates are
committed (`research/summary.json`); per-document rows stay on the machine that
produced them, because the fetcher lives in this repository and a published
document id could be matched back to the file it came from.

## Running it

```sh
npm install
npm run dev        # local dev server
npm run build      # static build into dist/
npm test           # 107 assertions across six suites
npm run typecheck
npm run fixtures   # regenerate the test PDFs
```

The corpus tooling is separate and needs the network:

```sh
node --experimental-strip-types test/corpus.mjs fetch   # a diverse sample
node --experimental-strip-types test/corpus.mjs scan    # look for false positives
node --experimental-strip-types test/corpus.mjs cjk     # Korean and Chinese redactions
```

The browser suite needs Chrome or Edge installed; it drives whichever it finds.

## Layout

```
src/lib/          scanning and cleaning — no DOM, no network, usable from Node
src/scripts/      the browser side: dropzone, report rendering, cleaner panel
src/pages/        the site: tool, guides, research
src/worker.ts     serves the site; three endpoints, none of which takes a file
test/             fixtures, unit suites, and an end-to-end browser run
research/         corpus tooling and the published aggregate
```

## Limits

Structural analysis reads the file, not the picture. Text burned into a scanned
image is out of reach, encrypted files are detected but not opened, and no
automated check can judge whether the visible content should have been published
at all.
