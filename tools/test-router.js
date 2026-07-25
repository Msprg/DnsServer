/*
Router regression tests.

Loads the real index.html, the real jQuery/Bootstrap, and the fork's own
router.js / ux.js / search.js into jsdom, stubs only the HTTP layer, and drives
the same call sequences the console does. Catches the class of bug where the
URL is written correctly and then overwritten a moment later by an async
callback that misreads the DOM.

    npm install jsdom@22
    node tools/test-router.js

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

function boot(startUrl) {
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

                showEditZonePage(showPageNumber);      // editor still hidden here

                $("#divEditZone").show();
            }});
        }

        function showEditZonePage(pageNumber) {
            if (pageNumber != null) $("#txtEditZonePageNumber").val(pageNumber);
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

async function bootReady(startUrl) {
    const window = boot(startUrl);

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
