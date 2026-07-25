/*
Web console regression tests.

Loads the real index.html, the real jQuery/Bootstrap, and the fork's own
router.js / ux.js / search.js into jsdom, stubs only the HTTP layer, and drives
the same call sequences the console does.

Covers routing - including the class of bug where the URL is written correctly
and then overwritten a moment later by an async callback that misreads the DOM
- and the search box's keyboard handling, where a wrong guard silently either
swallows the user's keystrokes or hijacks every field on the page.

    npm install jsdom@22
    node tools/test-webapp.js

Exit code is 0 when every test passes, 1 otherwise.
*/

"use strict";

const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.dirname(__dirname);
const WWW = path.join(ROOT, "DnsServerCore", "www");

const results = [];

function check(name, actual, expected) {
    const ok = actual === expected;
    results.push({ name, ok, actual, expected });
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
    if (!ok) {
        console.log(`         expected: ${expected}`);
        console.log(`         actual:   ${actual}`);
    }
}

// --------------------------------------------------------------- environment

function boot(startUrl, seed) {
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", () => {});   // css parse noise from bootstrap
    if (process.env.ROUTER_TEST_VERBOSE) {
        virtualConsole.on("warn", (...a) => console.log("   [window warn]", ...a));
        virtualConsole.on("error", (...a) => console.log("   [window error]", ...a));
    }

    const html = fs.readFileSync(path.join(WWW, "index.html"), "utf8");

    const dom = new JSDOM(html, {
        url: "http://localhost:5380" + (startUrl || "/"),
        runScripts: "outside-only",
        pretendToBeVisual: true,
        virtualConsole,
    });

    const { window } = dom;

    // jsdom has no layout engine, so :visible would always be false. Bootstrap
    // and the fork both rely on it, so back it with the inline display style
    // the console actually toggles.
    function evaluate(file) {
        window.eval(fs.readFileSync(path.join(WWW, "js", file), "utf8"));
    }

    evaluate("jquery.min.js");
    window.eval(`
        jQuery.expr.pseudos.visible = function (elem) {
            for (var e = elem; e && e.style; e = e.parentElement) {
                if (e.style.display === "none") return false;
            }
            return true;
        };
        jQuery.expr.pseudos.hidden = function (elem) {
            return !jQuery.expr.pseudos.visible(elem);
        };
    `);
    evaluate("bootstrap.min.js");

    // minimal stand-ins for the parts of the console the router talks to
    window.eval(`
        var sessionData = { token: "t", info: { permissions: {} } };
        ["Dashboard","Zones","Cache","Allowed","Blocked","Apps","DnsClient",
         "Settings","DhcpServer","Administration","Logs"].forEach(function (s) {
            sessionData.info.permissions[s] = { canView: true };
        });

        window.__pending = [];
        function HTTPRequest(o) { window.__pending.push(o); }
        function showAlert() {}
        function hideAlert() {}
        function htmlEncode(v) { return String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
        function showPageLogin() {}
        function refreshDashboard() {}
        function refreshApps() {}
        function refreshDnsSettings() {}
        function loadDnsSettings() {}
        function refreshDhcpLeases() {}
        function refreshDhcpScopes() {}
        function showEditDhcpScope() {}
        function refreshCachedZonesList() {}
        function refreshAllowedZonesList() {}
        function refreshBlockedZonesList() {}
        function resolveQuery() {}
        function viewLog() {}
        function queryLogs() {}
        function refreshLogFilesList() {}
        function refreshQueryLogsTab() {}
        function refreshAdminSessions() {}
        function refreshAdminUsers() {}
        function refreshAdminGroups() {}
        function refreshAdminPermissions() {}
        function refreshAdminSsoConfig() {}
        function refreshAdminCluster() {}

        // the records a zone is loaded with; tests may replace this fixture
        var editZoneRecords = null;
        var editZoneFilteredRecords = null;

        window.__zoneRecords = [
            { name: "my.zone.com",      type: "A",     ttl: 3600, rData: { ipAddress: "10.0.0.7" }, comments: "" },
            { name: "www.zone.com",     type: "A",     ttl: 3600, rData: { ipAddress: "10.0.0.8" }, comments: "public" },
            { name: "zone.com",         type: "SOA",   ttl: 900,  rData: { primaryNameServer: "ns1.zone.com" }, comments: "" },
            { name: "mail.zone.com",    type: "MX",    ttl: 3600, rData: { exchange: "mx.zone.com", preference: 10 }, comments: "" },
            { name: "old.zone.com",     type: "CNAME", ttl: 300,  rData: { cname: "www.zone.com" }, comments: "retired" }
        ];

        // Reproduces upstream showEditZone()'s ordering exactly: hide both
        // panes, fetch, then call showEditZonePage() BEFORE showing the editor.
        function showEditZone(zone, showPageNumber, filterName, filterType) {
            if (showPageNumber == null) showPageNumber = 1;
            if (filterName == null) filterName = "";
            if (filterType == null) filterType = "";

            $("#divViewZones").hide();
            $("#divEditZone").hide();

            HTTPRequest({ deliver: function () {
                $("#titleEditZone").attr("data-zone", zone);
                $("#titleEditZone").attr("data-zone-type", "Primary");
                $("#txtEditZoneFilterName").val(filterName);
                $("#txtEditZoneFilterType").val(filterType);
                $("#txtEditZonePageNumber").val(showPageNumber);

                editZoneRecords = window.__zoneRecords;
                editZoneFilteredRecords = null;

                showEditZonePage(showPageNumber);      // editor still hidden here

                $("#divEditZone").show();
            }});
        }

        // Mirrors upstream's filtering contract, which is what the fork's zone
        // search hooks into: the filter is only evaluated when
        // editZoneFilteredRecords is null, and a name with no * or ? in it is
        // an EXACT match on the fully qualified name.
        function showEditZonePage(pageNumber) {
            if (pageNumber != null) $("#txtEditZonePageNumber").val(pageNumber);

            if (editZoneRecords == null) return;

            var filterName = $("#txtEditZoneFilterName").val();
            if (filterName === "") filterName = null;

            var filterType = $("#txtEditZoneFilterType").val();
            if (filterType === "") filterType = null;

            var zone = $("#titleEditZone").attr("data-zone");

            if (editZoneFilteredRecords == null) {
                if ((filterName != null) || (filterType != null)) {
                    editZoneFilteredRecords = [];

                    var filterDomain = null, filterRegex = null;

                    if (filterName != null) {
                        filterDomain = filterName.toLowerCase();
                        filterDomain = (filterDomain === "@") ? zone : filterDomain + "." + zone;

                        if ((filterName.indexOf("*") > -1) || (filterName.indexOf("?") > -1)) {
                            // backslashes are doubled: this whole block is a template literal
                            filterRegex = new RegExp("^" + filterDomain
                                .replace(/\\./g, "\\\\.").replace(/\\*/g, ".*").replace(/\\?/g, ".") + "$");
                        }
                    }

                    if (filterType != null) filterType = filterType.toUpperCase();

                    for (var i = 0; i < editZoneRecords.length; i++) {
                        var record = editZoneRecords[i];

                        if (filterRegex == null) {
                            if ((filterDomain != null) && (record.name.toLowerCase() !== filterDomain)) continue;
                        }
                        else if (!filterRegex.test(record.name.toLowerCase())) continue;

                        if ((filterType != null) && (record.type !== filterType)) continue;

                        record.index = i;
                        editZoneFilteredRecords.push(record);
                    }
                }
                else {
                    for (var j = 0; j < editZoneRecords.length; j++) editZoneRecords[j].index = j;
                    editZoneFilteredRecords = editZoneRecords;
                }
            }

            var rows = "";
            for (var k = 0; k < editZoneFilteredRecords.length; k++) {
                rows += "<tr data-name='" + editZoneFilteredRecords[k].name +
                    "' data-type='" + editZoneFilteredRecords[k].type + "'></tr>";
            }
            $("#tableEditZoneBody").html(rows);
        }

        function refreshZones(checkDisplay, pageNumber) {
            $("#divViewZones").hide();
            $("#divEditZone").hide();

            HTTPRequest({ deliver: function () {
                if (pageNumber != null) $("#txtZonesPageNumber").val(pageNumber);
                $("#divViewZones").show();
            }});
        }
    `);

    // each JSDOM gets its own sessionStorage and cookie jar, so a cross
    // navigation round trip (the SSO flow) has to be staged by hand here,
    // before router.js is evaluated and reads either of them
    if (seed != null)
        seed(window);

    evaluate("router.js");
    evaluate("ux.js");
    evaluate("search.js");

    return window;
}

// Router.init() and UX.init() run from jQuery's ready queue, which fires on a
// later tick than boot() returns - and with a 620 KB index.html that tick is
// not necessarily the next one. Poll rather than guess a delay.
function tick(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms || 0));
}

async function bootReady(startUrl, seed) {
    const window = boot(startUrl, seed);

    for (let i = 0; i < 200 && !window.jQuery.isReady; i++)
        await tick(5);

    if (!window.jQuery.isReady)
        throw new Error("jQuery never became ready");

    await tick(5);   // let the ready callbacks themselves run
    return window;
}

// resolves the single queued request, the way the browser would
function deliver(window) {
    const queue = window.__pending;
    while (queue.length) queue.shift().deliver();
}

// the search API is called with success/error rather than deliver
function respond(window, responseJSON) {
    const request = window.__pending.shift();
    if (request == null) throw new Error("no request was issued");
    request.success(responseJSON);
    return request;
}

// A synthetic jQuery.Event is the only reliable way to drive jQuery's keydown
// handlers here: jsdom builds KeyboardEvents with keyCode 0, so jQuery's
// event.which would come out as 0 for every key.
function press(window, props) {
    window.jQuery(window.document).trigger(window.jQuery.Event("keydown", props));
}

function pressIn(window, selector, props) {
    window.jQuery(selector).trigger(window.jQuery.Event("keydown", props));
}

// jsdom does not type for us, so the characters after the one that opened the
// box have to be put in by hand, exactly as the browser would have
function typeInto(window, selector, text) {
    press(window, { key: text.charAt(0) });

    if (text.length > 1)
        window.jQuery(selector).val(text).trigger("input");
}

const typeToSearch = (window, text) => typeInto(window, "#txtGlobalSearch", text);
const typeToZone = (window, text) => typeInto(window, "#txtEditZoneFilterName", text);

// what the zone editor's table is currently showing
function shownRecords(window) {
    return window.jQuery("#tableEditZoneBody tr").map(function () {
        return window.jQuery(this).attr("data-name");
    }).get();
}

function searchResponse(results) {
    return { response: { truncated: false, zones: [], results: results } };
}

function url(window) {
    return window.location.pathname + window.location.search;
}

function startRouter(window) {
    window.$("#pageMain").show();
    window.$("#pageLogin").hide();
    window.Router.start();
}

// -------------------------------------------------------------------- tests

async function main() {

console.log("\nOpening a zone keeps its parameters in the URL");
{
    const w = await bootReady();
    startRouter(w);
    check("lands on the default tab", url(w), "/?t=dashboard");

    w.$("#mainPanelTabListZones").children("a").first()[0].click();
    deliver(w);
    check("zones tab", url(w), "/?t=zones");

    w.showEditZone("example.com", 1, "", "");
    check("URL set as soon as the zone is opened", url(w), "/?t=zones&zone=example.com");

    // the regression: showEditZonePage() fires while both panes are hidden
    deliver(w);
    check("URL survives the response landing", url(w), "/?t=zones&zone=example.com");
}

console.log("\nZone page and filters are carried, and do not stack history entries");
{
    const w = await bootReady();
    startRouter(w);
    w.$("#mainPanelTabListZones").children("a").first()[0].click();
    deliver(w);

    w.showEditZone("example.com", 2, "www", "A");
    deliver(w);
    check("page and filters in URL", url(w), "/?t=zones&zone=example.com&p=2&fn=www&ft=A");

    w.$("#txtEditZonePageNumber").val(3);
    w.showEditZonePage(3);
    check("paging refines the URL", url(w), "/?t=zones&zone=example.com&p=3&fn=www&ft=A");
}

console.log("\nGoing back to the zone list drops the zone");
{
    const w = await bootReady();
    startRouter(w);
    w.$("#mainPanelTabListZones").children("a").first()[0].click();
    deliver(w);
    w.showEditZone("example.com", 1, "", "");
    deliver(w);
    check("in the zone", url(w), "/?t=zones&zone=example.com");

    w.refreshZones(false, 1);
    deliver(w);
    check("back on the list", url(w), "/?t=zones");
}

console.log("\nRestoring a deep link from a cold boot");
{
    const w = await bootReady("/?t=zones&zone=example.com&p=2&fn=www");
    startRouter(w);
    deliver(w);
    check("zone editor is showing", w.$("#divEditZone").is(":visible"), true);
    check("data-zone restored", w.$("#titleEditZone").attr("data-zone"), "example.com");
    check("URL preserved", url(w), "/?t=zones&zone=example.com&p=2&fn=www");
}

console.log("\nSub-tabs are routable");
{
    const w = await bootReady();
    startRouter(w);
    w.$("#mainPanelTabListSettings").children("a").first()[0].click();
    w.$("#settingsTabListRecursion").children("a").first()[0].click();
    check("settings sub-tab", url(w), "/?t=settings.recursion");

    w.$("#mainPanelTabListAdmin").children("a").first()[0].click();
    w.$("#adminTabListUsers").children("a").first()[0].click();
    check("admin sub-tab", url(w), "/?t=admin.users");
}

console.log("\nCopy-link reports the same URL the address bar shows");
{
    const w = await bootReady();
    startRouter(w);
    w.$("#mainPanelTabListZones").children("a").first()[0].click();
    deliver(w);
    w.showEditZone("example.com", 1, "", "");
    deliver(w);
    check("Router.url() matches", w.Router.url(), "http://localhost:5380/?t=zones&zone=example.com");
}

console.log("\nAn SSO round trip comes back to the requested view");
{
    // the deep link that put the login page on screen
    const w1 = await bootReady("/?t=zones&zone=example.com&p=2");
    const parked = w1.sessionStorage.getItem("routerReturnTo");
    check("the route is parked before the browser leaves for the provider",
        parked != null, true);

    // /sso/login -> provider -> /sso/callback -> Location: "/" + token cookie
    const w2 = await bootReady("/", (w) => {
        w.sessionStorage.setItem("routerReturnTo", parked);
        w.document.cookie = "token=abc123";
    });
    check("the router has a route to restore", w2.Router.hasPendingRoute(), true);

    startRouter(w2);
    deliver(w2);
    check("landed back on the zone", url(w2), "/?t=zones&zone=example.com&p=2");
    check("the zone editor is showing", w2.$("#divEditZone").is(":visible"), true);
}

console.log("\nA parked route is spent once and never hijacks a plain visit");
{
    // same tab, no token cookie: the user just typed the console URL
    const stale = JSON.stringify({ q: "?t=zones&zone=example.com", at: Date.now() });
    const w1 = await bootReady("/", (w) => w.sessionStorage.setItem("routerReturnTo", stale));
    check("no route restored without an SSO return", w1.Router.hasPendingRoute(), false);
    startRouter(w1);
    check("lands on the default tab", url(w1), "/?t=dashboard");

    // an SSO return with an expired entry gets the default tab too
    const expired = JSON.stringify({ q: "?t=zones&zone=example.com", at: Date.now() - (31 * 60 * 1000) });
    const w2 = await bootReady("/", (w) => {
        w.sessionStorage.setItem("routerReturnTo", expired);
        w.document.cookie = "token=abc123";
    });
    check("an expired parked route is ignored", w2.Router.hasPendingRoute(), false);
    check("and is cleared rather than left to rot",
        w2.sessionStorage.getItem("routerReturnTo"), null);
}

console.log("\nTyping anywhere opens the search box");
{
    const w = await bootReady();
    startRouter(w);

    typeToSearch(w, "web");
    check("the keystrokes land in the search box", w.$("#txtGlobalSearch").val(), "web");
    check("and it has the focus", w.document.activeElement.id, "txtGlobalSearch");

    await tick(400); // past the debounce
    const request = w.__pending.shift();
    check("a search was issued", request != null, true);
    check("across every zone", /[?&]zone=/.test(request.url), false);
}

console.log("\nType to search keeps its hands off everything else");
{
    const w = await bootReady();
    startRouter(w);

    // a real field on the page: its own keystrokes are not ours to take
    pressIn(w, "#txtZonesFilterName", { key: "w" });
    check("typing in a field is left alone", w.$("#txtGlobalSearch").val(), "");

    press(w, { key: "f", ctrlKey: true });
    check("ctrl combinations are left to the browser", w.$("#txtGlobalSearch").val(), "");

    press(w, { key: "Tab" });
    check("named keys are not printable characters", w.$("#txtGlobalSearch").val(), "");

    press(w, { key: "/" });
    check("slash opens the box without seeding it", w.$("#txtGlobalSearch").val(), "");
    check("but does focus it", w.document.activeElement.id, "txtGlobalSearch");
}

console.log("\nInside a zone, typing goes to that zone's own search");
{
    const w = await bootReady();
    startRouter(w);
    w.$("#mainPanelTabListZones").children("a").first()[0].click();
    deliver(w);
    w.showEditZone("zone.com", 1, "", "");
    deliver(w);

    typeToZone(w, "my");
    check("the keystrokes land in the zone's filter", w.$("#txtEditZoneFilterName").val(), "my");
    check("and not in the header box", w.$("#txtGlobalSearch").val(), "");

    await tick(300);
    check("the table is filtered as you type, with no Go press",
        shownRecords(w).join(","), "my.zone.com");
    check("nothing was asked of the server", w.__pending.length, 0);

    // the header box stays global even from in here
    w.$("#txtGlobalSearch").val("www").trigger("input");
    await tick(400);
    check("the header search is never scoped to the zone",
        /[?&]zone=/.test(w.__pending.shift().url), false);
}

console.log("\nThe zone search is fuzzy, not an exact match hunt");
{
    const w = await bootReady();
    startRouter(w);
    w.$("#mainPanelTabListZones").children("a").first()[0].click();
    deliver(w);
    w.showEditZone("zone.com", 1, "", "");
    deliver(w);

    const filter = async (text) => {
        w.$("#txtEditZoneFilterName").val(text).trigger("input");
        await tick(300);
        return shownRecords(w);
    };

    // "ww" is half a label, so upstream's exact match on "ww.zone.com" finds
    // nothing; a whole label would pass either way and prove nothing.
    // old.zone.com comes along because it is a CNAME pointing at www.
    check("half a label matches, no stars needed",
        (await filter("ww")).join(","), "www.zone.com,old.zone.com");
    check("a record is found by its value",
        (await filter("10.0.0.8")).join(","), "www.zone.com");
    check("and by its comment", (await filter("retired")).join(","), "old.zone.com");
    check("and by its type", (await filter("mx")).join(","), "mail.zone.com");
    check("space separated terms all have to match",
        (await filter("zone a 10.0.0.7")).join(","), "my.zone.com");
    check("a term that matches nothing empties the table",
        (await filter("nosuchthing")).length, 0);
    check("clearing it brings everything back", (await filter("")).length, 5);

    // upstream's wildcard syntax is left exactly as it was
    check("a wildcard filter still anchors the way upstream does",
        (await filter("*.zone.com")).length, 0);
    check("a wildcard filter matches on the zone relative name",
        (await filter("w*")).join(","), "www.zone.com");
}

console.log("\nArrows highlight a result and enter opens it");
{
    const w = await bootReady();
    startRouter(w);

    typeToSearch(w, "api");
    await tick(400);

    respond(w, searchResponse([
        { zone: "example.com", zoneType: "Primary", record: { name: "api.example.com", type: "A", rData: { ipAddress: "10.0.0.1" } } },
        { zone: "other.example", zoneType: "Primary", record: { name: "api.other.example", type: "A", rData: { ipAddress: "10.0.0.2" } } }
    ]));
    check("both results are listed", w.$(".global-search-item").length, 2);

    pressIn(w, "#txtGlobalSearch", { which: 40 });
    pressIn(w, "#txtGlobalSearch", { which: 40 });
    check("the second result is highlighted",
        w.$(".global-search-item.active").attr("data-zone"), "other.example");

    pressIn(w, "#txtGlobalSearch", { which: 13 });
    deliver(w);
    check("enter opens it, filtered to that one record",
        url(w), "/?t=zones&zone=other.example&fn=api&ft=A");

    pressIn(w, "#txtGlobalSearch", { which: 38 });
    check("the results are dismissed once one is taken",
        w.$("#divGlobalSearchResults").is(":visible"), false);

    // the reported bug: the term stayed put, so the next thing typed was
    // appended to it and searched for "zone.commy"
    check("and the box is emptied, not left holding the old term",
        w.$("#txtGlobalSearch").val(), "");
}

console.log("\nThe zone row ranks by how often a zone is opened");
{
    const w = await bootReady();
    startRouter(w);

    // opening a zone, paging inside it, and filtering it is one visit, not four
    const visit = (zone) => {
        w.showEditZone(zone, 1, "", "");
        deliver(w);
        w.showEditZonePage(2);
        w.showEditZonePage(3);
        w.refreshZones(false, 1);
        deliver(w);
    };

    // the quiet zone is visited last, so ranking by recency and ranking by use
    // disagree here - which is the whole point of the row
    visit("busy.example");
    visit("busy.example");
    visit("busy.example");
    visit("quiet.example");

    check("the most opened zone leads, not the most recent one",
        w.UX.zoneUsage().join(","), "busy.example,quiet.example");
    check("paging inside a zone is not counted as reopening it",
        JSON.parse(w.localStorage.getItem("zoneUsage"))["busy.example"].n, 3);

    check("a chip per zone", w.$("#divFrequentZones .zone-chip").length, 2);
    check("leader first", w.$("#divFrequentZones .zone-chip-open").first().attr("data-zone"), "busy.example");

    // the chips sit on the button row, after the buttons so they yield to them
    check("the row is on the buttons' row",
        w.$("#divFrequentZones").prev().hasClass("pull-right"), true);

    w.$("#divFrequentZones .zone-chip-forget").first()[0].click();
    check("a zone can be dropped from the row", w.UX.zoneUsage().join(","), "quiet.example");
    check("and the chip goes with it", w.$("#divFrequentZones .zone-chip").length, 1);

    w.$("#divFrequentZones .zone-chip-open").first()[0].click();
    deliver(w);
    check("clicking a chip opens that zone", url(w), "/?t=zones&zone=quiet.example");
}

console.log("\nThe zone row follows you into a zone");
{
    const w = await bootReady();
    startRouter(w);
    w.$("#mainPanelTabListZones").children("a").first()[0].click();
    deliver(w);

    const visit = (zone) => {
        w.showEditZone(zone, 1, "", "");
        deliver(w);
        w.refreshZones(false, 1);
        deliver(w);
    };

    visit("one.example");
    visit("two.example");

    // the editor's own copy, so switching zones needs no trip back to the list
    w.showEditZone("one.example", 1, "", "");
    deliver(w);
    check("the editor carries the row too",
        w.$("#divFrequentZonesEditor .zone-chip").length, 2);
    check("it sits between Back and the cluster selector",
        w.$("#divFrequentZonesEditor").prev().find("#optEditZoneClusterNode").length, 1);

    check("the zone being viewed is marked",
        w.$("#divFrequentZonesEditor .zone-chip.active .zone-chip-open").attr("data-zone"), "one.example");
    check("and only that one", w.$("#divFrequentZonesEditor .zone-chip.active").length, 1);

    // straight to another zone without going back first
    w.$("#divFrequentZonesEditor .zone-chip-open[data-zone='two.example']")[0].click();
    deliver(w);
    check("a chip switches zones from inside a zone", url(w), "/?t=zones&zone=two.example");
    check("and the marker follows",
        w.$("#divFrequentZonesEditor .zone-chip.active .zone-chip-open").attr("data-zone"), "two.example");

    w.refreshZones(false, 1);
    deliver(w);
    check("back on the list, nothing is marked", w.$(".zone-chip.active").length, 0);
}

console.log("\nThe old recent-zones list is carried over, not thrown away");
{
    const w = await bootReady("/", (win) =>
        win.localStorage.setItem("recentZones", JSON.stringify(["newest.example", "older.example"])));

    check("the previous list becomes the starting order",
        w.UX.zoneUsage().join(","), "newest.example,older.example");
    check("and is not migrated a second time", w.localStorage.getItem("recentZones"), null);

    // a zone opened once now outranks anything only carried over
    startRouter(w);
    w.showEditZone("older.example", 1, "", "");
    deliver(w);
    check("a real visit beats a migrated entry", w.UX.zoneUsage()[0], "older.example");
}

console.log("\nBack and forward");
{
    const w = await bootReady();
    startRouter(w);
    w.$("#mainPanelTabListZones").children("a").first()[0].click();
    deliver(w);
    w.showEditZone("example.com", 1, "", "");
    deliver(w);
    check("at the zone", url(w), "/?t=zones&zone=example.com");

    w.history.back();
    // jsdom applies history changes asynchronously
}

// ------------------------------------------------------------------- result

}

main().then(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
}).catch((e) => {
    console.error(e);
    process.exit(1);
});
