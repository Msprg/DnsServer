#!/usr/bin/env python3
"""
Post-merge sanity check for this fork.

Run after merging upstream. Verifies, without needing a browser or a build,
that everything the fork's add-on files hook into is still there:

  1. every FORK marker is still present in the upstream files that need one
  2. every fork asset is declared in DnsServerCore.csproj, which lists www
     files by hand rather than globbing them
  3. every element id the fork injects markup next to, or styles, still exists
  4. every upstream global function the fork wraps is still defined
  5. every routable tab in router.js still maps to real elements
  6. the fork's own JavaScript still parses (only if `esprima` is importable)

Exit code is 0 when everything checks out, 1 otherwise.
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WWW = os.path.join(ROOT, "DnsServerCore", "www")

failures = []
notes = []


def read(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as f:
        return f.read()


def check(ok, message):
    print(("  ok   " if ok else "  FAIL ") + message)
    if not ok:
        failures.append(message)


# --------------------------------------------------------------- 1. markers

# file -> how many FORK markers it should carry
EXPECTED_MARKERS = {
    "DnsServerCore/www/index.html": 2,
    "DnsServerCore/www/js/auth.js": 1,
    "DnsServerCore/www/js/main.js": 2,
    "DnsServerCore/WebServiceZonesApi.cs": 1,
    "DnsServerCore/DnsWebService.cs": 1,
    "DnsServerCore/DnsServerCore.csproj": 1,
    "docker-compose.yml": 1,
}

print("\nFORK markers in upstream files")
for path, expected in EXPECTED_MARKERS.items():
    try:
        found = len(re.findall(r"FORK", read(*path.split("/"))))
    except FileNotFoundError:
        check(False, "%s is missing entirely" % path)
        continue
    check(found == expected, "%s has %d FORK marker(s), expected %d" % (path, found, expected))


# ---------------------------------------------------- 2. fork-only files

print("\nFork-only files present")
for path in [
    "DnsServerCore/WebServiceZonesApiSearch.cs",
    "DnsServerCore/www/css/ux.css",
    "DnsServerCore/www/js/router.js",
    "DnsServerCore/www/js/search.js",
    "DnsServerCore/www/js/ux.js",
]:
    check(os.path.exists(os.path.join(ROOT, path)), path)


# ------------------------------------------------------------- 3. anchors

html = read("DnsServerCore", "www", "index.html")
html_ids = set(re.findall(r'\bid="([^"]+)"', html))

print("\nDOM anchors the fork injects markup next to")
for anchor in [
    "lnkUpdateAvailable",            # global search box + copy-link button
    "optZonesClusterNode",           # anchors the most-used-zones row on the button row
    "tableZones",                    # zones search hint
    "lblCreateApiTokenOutputToken",  # copy button
    "btnDeleteCachedZone",           # copy button
    "btnDeleteLog",                  # copy button
    "preDnsClientFinalResponse",     # copy button
    "preCachedZoneViewerBody",       # copy target
    "preLogViewerBody",              # copy target
    "tableDnssecViewDsBody",         # DS click-to-copy
    "divDnssecViewDsAlert",          # DS copy confirmation
    "pageMain",                      # type-to-search only arms once past the login page
    "divEditZone",                   # type-to-search reads the zone in view from these two
    "titleEditZone",
]:
    check(anchor in html_ids, "#" + anchor)

print("\nAsset tags still referenced by index.html")
for asset in ["css/ux.css", "js/router.js", "js/ux.js", "js/search.js"]:
    check(asset in html, asset)

# ux.js must load before search.js: it injects the box search.js binds to
if "js/ux.js" in html and "js/search.js" in html:
    check(html.index("js/ux.js") < html.index("js/search.js"),
          "js/ux.js is loaded before js/search.js")


# --------------------------------------- 3b. assets declared in the csproj

# DnsServerCore.csproj lists every www file by hand instead of globbing, so an
# asset that is not declared there is silently missing from the publish output
# and 404s at runtime even though index.html references it.
csproj = read("DnsServerCore", "DnsServerCore.csproj")

print("\nFork assets declared in DnsServerCore.csproj")
for asset in ["www/css/ux.css", "www/js/router.js", "www/js/search.js", "www/js/ux.js"]:
    declared = ('Content Include="%s"' % asset.replace("/", "\\")) in csproj
    check(declared, asset)

# and catch any future asset added to index.html but not to the csproj
referenced = set(re.findall(r'(?:src|href)="((?:js|css)/[^"]+)"', html))
for asset in sorted(referenced):
    if ('Content Include="www\\%s"' % asset.replace("/", "\\")) not in csproj:
        notes.append("index.html references %s but DnsServerCore.csproj does not declare it; "
                     "it will 404 in a published build" % asset)


# ------------------------------------------------- 4. wrapped globals

APP_JS = ["common.js", "main.js", "auth.js", "cluster.js", "zone.js",
          "other-zones.js", "apps.js", "dnsclient.js", "dhcp.js", "logs.js"]

upstream_globals = set()
for name in APP_JS:
    upstream_globals |= set(re.findall(
        r"^function\s+([A-Za-z_$][\w$]*)", read("DnsServerCore", "www", "js", name), re.M))

print("\nUpstream globals the fork wraps or calls")
for fn in [
    "showEditZone", "showEditZonePage", "refreshZones",
    "refreshCachedZonesList", "refreshAllowedZonesList", "refreshBlockedZonesList",
    "resolveQuery", "viewLog", "queryLogs", "showEditDhcpScope", "refreshDhcpScopes",
    "refreshDhcpLeases", "refreshDashboard", "refreshApps", "refreshDnsSettings",
    "refreshLogFilesList", "refreshQueryLogsTab", "loadDnsSettings", "showPageLogin",
    "showPageMain", "refreshAdminSessions", "refreshAdminUsers", "refreshAdminGroups",
    "refreshAdminPermissions", "refreshAdminSsoConfig", "refreshAdminCluster",
    "showAlert", "htmlEncode", "HTTPRequest",
]:
    check(fn in upstream_globals, fn + "()")


# --------------------------------------------------------- 5. router tabs

router = read("DnsServerCore", "www", "js", "router.js")

print("\nRouter tab elements")
main_block = re.search(r"var MAIN_TABS = \[(.*?)\];", router, re.S)
sub_block = re.search(r"var SUB_TABS = \{(.*?)\n    \};", router, re.S)

if main_block is None or sub_block is None:
    check(False, "could not parse MAIN_TABS / SUB_TABS out of router.js")
else:
    missing = []
    for _key, ident in re.findall(r'key:\s*"([^"]+)",\s*id:\s*"([^"]+)"', main_block.group(1)):
        for pattern in ("mainPanelTabList%s", "mainPanelTabPane%s"):
            if (pattern % ident) not in html_ids:
                missing.append(pattern % ident)
    for group, block in re.findall(r"(\w+):\s*\[(.*?)\]", sub_block.group(1), re.S):
        for _key, ident in re.findall(r'key:\s*"([^"]+)",\s*id:\s*"([^"]+)"', block):
            for pattern in (group + "TabList%s", group + "TabPane%s"):
                if (pattern % ident) not in html_ids:
                    missing.append(pattern % ident)
    check(not missing, "all routed tabs resolve" + ("" if not missing else ": missing " + ", ".join(missing)))

    # a tab present upstream but absent from the router is not an error, just
    # a view that will not be routable until it is added
    upstream_main = set(re.findall(r'id="mainPanelTabList(\w+)"', html))
    routed_main = set(i for _k, i in re.findall(r'key:\s*"([^"]+)",\s*id:\s*"([^"]+)"', main_block.group(1)))
    unrouted = sorted(upstream_main - routed_main)
    if unrouted:
        notes.append("main tabs not yet routable (add to MAIN_TABS in router.js): " + ", ".join(unrouted))


# --------------------------------------------------- 6. css sticky targets

css = read("DnsServerCore", "www", "css", "ux.css")
print("\nSticky header selectors that still match something")
for ident in re.findall(r"#(\w+) thead th", css):
    if ident not in html_ids:
        notes.append("css/ux.css targets #%s, which no longer exists; that table just will not get a sticky header" % ident)
print("  ok   %d selector(s) checked" % len(re.findall(r"#(\w+) thead th", css)))


# -------------------------------------------------------- 7. parse check

print("\nFork JavaScript parses")
try:
    import esprima
except ImportError:
    print("  skip  esprima not installed (pip install esprima)")
else:
    for name in ["router.js", "search.js", "ux.js"]:
        try:
            esprima.parseScript(read("DnsServerCore", "www", "js", name))
            check(True, name)
        except Exception as ex:  # noqa: BLE001
            check(False, "%s does not parse: %s" % (name, ex))


# ------------------------------------------------------------------ result

print()
for note in notes:
    print("NOTE: " + note)

if failures:
    print("\n%d check(s) failed. See FORK.md for what each hook is for." % len(failures))
    sys.exit(1)

print("\nAll checks passed.")
sys.exit(0)
