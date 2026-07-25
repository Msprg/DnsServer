# Fork notes

This is a fork of [TechnitiumSoftware/DnsServer](https://github.com/TechnitiumSoftware/DnsServer)
that adds some web console UX work. It is meant to be kept in sync with upstream,
so everything here is structured to keep the diff against upstream as small and
as mechanical to re-apply as possible.

## What the fork adds

| Feature | Where |
|---|---|
| URL reflects the current view; refresh / bookmark / new tab restore it; browser back and forward work; the requested view survives an SSO login | `DnsServerCore/www/js/router.js` |
| Global search across every zone's records, by name, record data or comment | `DnsServerCore/www/js/search.js` + `DnsServerCore/WebServiceZonesApiSearch.cs` |
| Zone record search: fuzzy instead of exact, matching values and comments too, filtering the table as you type | `DnsServerCore/www/js/search.js` |
| Type anywhere to search &mdash; the zone's own filter while a zone is open, the header box otherwise | `DnsServerCore/www/js/search.js` |
| Copy to clipboard, a row of the most used zones on both the zone list and the zone editor, unsaved settings guard, working page size selects | `DnsServerCore/www/js/ux.js` |
| Styling for all of the above, including dark and amber themes, plus sticky table headers | `DnsServerCore/www/css/ux.css` |

## Design rule

**All fork logic lives in files that do not exist upstream.** Those files hook
into the console by wrapping existing global functions and by injecting their
own markup at `$(document).ready`, rather than by editing upstream code.

Anything that unavoidably touches an upstream file is marked with a `FORK`
comment. To see every one of them:

```bash
grep -rn FORK --include='*.cs' --include='*.js' --include='*.html' \
    DnsServerCore/ docker-compose.yml
```

## Files that exist only in the fork

Nothing upstream references these, so they never conflict.

```
FORK.md
.github/workflows/docker-publish.yml
DnsServerCore/WebServiceZonesApiSearch.cs
DnsServerCore/www/css/ux.css
DnsServerCore/www/js/router.js
DnsServerCore/www/js/search.js
DnsServerCore/www/js/ux.js
```

## Every change to an upstream file

Eleven hunks across nine files. This is the entire conflict surface, and it is
worth re-deriving rather than trusting after a merge:

```bash
git fetch upstream
git diff --stat upstream/master...HEAD -- . \
    ':!FORK.md' ':!tools' ':!.github' \
    ':!DnsServerCore/WebServiceZonesApiSearch.cs' \
    ':!DnsServerCore/www/js/router.js' ':!DnsServerCore/www/js/search.js' \
    ':!DnsServerCore/www/js/ux.js' ':!DnsServerCore/www/css/ux.css'
```

| File | Change |
|---|---|
| `DnsServerCore/www/index.html` | One `<link>` and three `<script>` tags in `<head>`, in two hunks. Nothing else — all fork markup is injected by `js/ux.js`. |
| `DnsServerCore/www/js/auth.js` | The boot handler's `replaceState` gains `+ window.location.search`, so the query string survives startup. |
| `DnsServerCore/www/js/main.js` | Two hunks in `showPageMain()`: guard the default `refreshZones(true)` so it does not race the routed view, and call `Router.start()` at the end. |
| `DnsServerCore/WebServiceZonesApi.cs` | The word `partial` on the `WebServiceZonesApi` class declaration. |
| `DnsServerCore/DnsWebService.cs` | One `MapGetAndPost` line registering `/api/zones/records/search`. |
| `APIDOCS.md` | A new "Search Records" section. Pure insertion. |
| `DnsServerCore/DnsServerCore.csproj` | Two `ItemGroup`s at the end of the file declaring the four fork assets. |
| `docker-compose.yml` | `image:` repointed at this fork's GHCR image. |
| `.gitignore` | `/node_modules/` and `/package-lock.json`, for the regression tests' jsdom install. |

## Syncing with upstream

```bash
git fetch upstream
git merge upstream/master        # or: git rebase upstream/master
```

Conflicts should be rare and confined to the table above. After merging:

1. Run the grep above and confirm all nine `FORK` markers are still present and
   still make sense. (Nine markers, eleven hunks: `.gitignore` and `APIDOCS.md`
   carry additions rather than marked edits.)
2. Check the anchors the fork depends on still exist. `js/ux.js` injects its
   markup next to these element ids, and `css/ux.css` targets tables by id:

   ```
   lnkUpdateAvailable   optZonesClusterNode   optEditZoneClusterNode   tableZones
   lblCreateApiTokenOutputToken   btnDeleteCachedZone   btnDeleteLog
   preDnsClientFinalResponse   preCachedZoneViewerBody   preLogViewerBody
   tableDnssecViewDsBody   divDnssecViewDsAlert
   pageMain   divEditZone   titleEditZone
   txtEditZoneFilterName   txtEditZoneFilterType
   ```

   If an anchor is renamed upstream, that one feature silently stops appearing;
   nothing breaks. The check script below reports it.
3. Check the global functions the fork wraps still exist with the same
   signatures: `showEditZone`, `showEditZonePage`, `refreshZones`,
   `refreshCachedZonesList`, `refreshAllowedZonesList`, `refreshBlockedZonesList`,
   `resolveQuery`, `viewLog`, `queryLogs`, `showEditDhcpScope`,
   `refreshDhcpScopes`, `loadDnsSettings`, `showPageLogin`.

   `js/search.js` also depends on two things inside upstream's
   `showEditZonePage()`: that it only evaluates the record filter when the global
   `editZoneFilteredRecords` is null, and that records carry `index` back into
   `editZoneRecords`. The fork's zone search fills that array in beforehand
   rather than reimplementing the paging. `tools/test-webapp.js` reproduces that
   contract, so if upstream changes it the tests fail rather than the console.

   Also check that `SsoLoginFinalizeAsync` in `WebServiceAuthApi.cs` still ends
   by setting a `token` cookie and redirecting to `/`. `js/router.js` treats
   that cookie as the signal that a page load is the tail of an SSO round trip.
   If upstream ever carries the return URL through the flow itself, the
   sessionStorage hand-off in `router.js` becomes redundant and should go.
4. If upstream adds a main tab or a sub-tab, add it to `MAIN_TABS` / `SUB_TABS`
   in `js/router.js` so it becomes routable.
5. If you add a new file under `www/`, declare it in `DnsServerCore.csproj`.
   That file lists every asset by hand instead of globbing, so an undeclared
   asset builds fine and then 404s at runtime. `tools/check-fork.py` checks
   this.

### Web console regression tests

`tools/test-webapp.js` loads the real `index.html`, the real jQuery/Bootstrap
and the fork's own scripts into jsdom and drives the same call sequences the
console does. It exists because the static checks cannot see a URL that is
written correctly and then overwritten a moment later by an async callback that
misreads the DOM - which is exactly how the zone parameters were once lost.

It also stages the SSO round trip by hand: one jsdom window for the login page,
a second one seeded with the first one's `sessionStorage` and a `token` cookie,
standing in for the browser's trip out to the identity provider and back.

The rest covers the two search mechanisms: the header box's keyboard handling,
where a wrong guard either silently swallows keystrokes or hijacks every field
on the page, and the zone filter, whose stub in the harness reproduces
upstream's `editZoneFilteredRecords` contract so the fork's fuzzy matching is
exercised against the real thing.

```bash
npm install --no-save jsdom@22
node tools/test-webapp.js
```

Both this and the check below run in CI before the image is built.

### Automated post-merge check

`tools/check-fork.py` verifies items 1 to 5 without needing a browser or a
build, and also confirms every fork asset is declared in the csproj:

```bash
python3 tools/check-fork.py
```

## Upstream bugs this fork works around

Both are corrected from fork-only files, so neither adds anything to merge.

| Bug | Worked around by |
|---|---|
| `main.css` puts `.AlertPlaceholder` at `z-index: 1000`, under Bootstrap's modal backdrop at 1040. Any alert raised while a modal is open is drawn behind it and never seen &mdash; including the error explaining why the thing you just did failed. | `.AlertPlaceholder { z-index: 1060 }` in `css/ux.css` |
| Restore Settings deletes config files off disk, behind a blue `btn-primary` that reads as the safe default. | `js/ux.js` restyles it `btn-danger`. The pre-ticked "Delete Existing Files" is left alone: it decides what a restore *means*, and that is upstream's call. |

### Upstream bugs deliberately left alone

Not worth the merge surface. Better reported upstream than carried here.

- **`serializeTableData()` return value unchecked** at `auth.js:2125-2126` and
  `zone.js:2622-2623`. It returns `false` when a field fails validation, and
  those four callers pass it straight to `encodeURIComponent`, sending the
  literal string `"false"` as the permission list. Every other caller guards it.
  Fixing it means editing two upstream files in functions the fork has no other
  reason to touch.
- **`sortTable()` in `common.js`** sorts only the rows currently rendered, so on
  a paged table it sorts one page and calls it sorted, and it compares with
  `innerText.toLowerCase()`, so serials and dates sort as text. Fixing it
  properly means sorting the underlying data and re-paging &mdash; a
  reimplementation that would drift from upstream silently.

## Known limitations

- The cluster node selector is not encoded in the URL, so on a cluster a reload
  returns to the default node. This is deliberate: reaching a particular node is
  an addressing question, better answered with a DNS name that points at it than
  with a URL parameter the console has to keep in sync.
- The `Docker Publish` workflow is the build of record: there is no .NET SDK and
  no sibling `TechnitiumLibrary` checkout in this working copy, so nothing here
  compiles locally. Push, and let CI tell you.
