/*
Technitium DNS Server
Copyright (C) 2026  Shreyas Zare (shreyas@technitium.com)

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.

*/

//
// Small quality of life additions that do not belong to any one screen:
//
//   - copy to clipboard buttons
//   - a row of the zones this browser opens most often
//   - remembering how many rows per page the user likes
//   - a warning before walking away from unsaved DNS settings
//
// Like the router, this file wraps the existing view functions from the
// outside rather than editing them, so that upstream changes stay mergeable.
//

var UX = (function () {
    "use strict";

    var RECENT_ZONES_KEY = "recentZones"; //superseded by ZONE_USAGE_KEY; read once, to migrate
    var ZONE_USAGE_KEY = "zoneUsage";
    var ZONE_USAGE_MAX = 50; //entries kept in storage
    var ZONE_CHIPS_MAX = 6; //chips offered; how many are actually shown is down to the width of the row

    var settingsDirty = false;

    //The zone the editor is showing, or null while the zone list is up. Doubles
    //as the guard that stops a single visit being counted once per page and
    //filter change, and as the chip to mark as the one you are looking at.
    var zoneInView = null;

    // ----------------------------------------------------------- clipboard

    function copyText(text, objBtn) {
        function done(ok) {
            if (objBtn == null)
                return;

            var button = $(objBtn);
            var original = button.attr("data-original-title-text");

            if (original == null) {
                original = button.html();
                button.attr("data-original-title-text", original);
            }

            button.html(ok ? "copied" : "failed");
            button.toggleClass("copied", ok);

            setTimeout(function () {
                button.html(original);
                button.removeClass("copied");
            }, 1200);
        }

        //navigator.clipboard is only available on secure origins, and this
        //console is very often reached over plain http on a LAN address
        if ((navigator.clipboard != null) && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(function () {
                done(true);
            }, function () {
                done(legacyCopy(text));
            });

            return;
        }

        done(legacyCopy(text));
    }

    function legacyCopy(text) {
        var textarea = document.createElement("textarea");

        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.top = "-1000px";
        textarea.style.opacity = "0";

        document.body.appendChild(textarea);

        var ok = false;

        try {
            textarea.select();
            textarea.setSelectionRange(0, textarea.value.length);
            ok = document.execCommand("copy");
        }
        catch (e) {
            ok = false;
        }
        finally {
            document.body.removeChild(textarea);
        }

        return ok;
    }

    // ------------------------------------------------------- markup injection

    //Every piece of markup this fork adds is injected here rather than written
    //into index.html, so that the fork's diff against upstream stays limited to
    //the four asset tags in <head>. Each anchor below is an element id that
    //upstream JS itself depends on, which makes them about as stable as
    //anything in that file. If an anchor ever disappears the feature quietly
    //does not appear, rather than breaking the console.
    function injectMarkup() {
        //the global search box, in the page header
        var updateLink = $("#lnkUpdateAvailable");

        if (updateLink.length > 0) {
            updateLink.css("margin-right", "10px").after(
                '<div id="divGlobalSearch" class="global-search">' +
                '<input type="text" id="txtGlobalSearch" class="form-control" placeholder="Search zones &amp; records..." autocomplete="off" spellcheck="false" aria-label="Search zones and records" />' +
                '<span id="lnkGlobalSearchClear" class="global-search-clear" title="Clear search">&times;</span>' +
                '<div id="divGlobalSearchResults" class="global-search-results"></div>' +
                '</div>');
        }

        //Most used zones, sharing the zone list's button row.
        //
        //Inserted after the buttons, not before: they are float:right, and the
        //row's stylesheet relies on following that float so it is handed only
        //the width the buttons leave over. See .frequent-zones in css/ux.css.
        var zonesButtons = $("#optZonesClusterNode").closest(".pull-right");

        if (zonesButtons.length > 0)
            zonesButtons.after('<div id="divFrequentZones" class="frequent-zones"></div>');

        //and again inside the zone editor, so switching zones does not mean
        //going back to the list first. That bar is floated on both sides - Back
        //on the left, the cluster node selector on the right - and the same
        //block formatting context fits between them.
        var editorNode = $("#optEditZoneClusterNode").closest(".pull-right");

        if (editorNode.length > 0)
            editorNode.after('<div id="divFrequentZonesEditor" class="frequent-zones frequent-zones-editor"></div>');

        //"search inside the zones instead" hint, above the zone table
        $('<div id="divZonesSearchHint" class="zones-search-hint" style="display: none;"></div>').insertBefore("#tableZones");

        //Restore Settings overwrites config on disk and, with the pre-ticked
        //option, deletes the existing files first. That is behind a blue
        //btn-primary, which reads as "the safe default action". The tick itself
        //is left alone - it decides what a restore means, and that is upstream's
        //call - but the button is made to look like what it does.
        $("#btnRestoreSettings").removeClass("btn-primary").addClass("btn-danger");

        //copy buttons on the values that get copied most often
        addCopyButton($("#lblCreateApiTokenOutputToken"), "after", "#lblCreateApiTokenOutputToken", "copy token", "margin-left: 0; margin-top: 4px;");
        addCopyButton($("#btnDeleteCachedZone"), "after", "#preCachedZoneViewerBody", "copy", null);
        addCopyButton($("#btnDeleteLog"), "after", "#preLogViewerBody", "copy", null);
        addCopyButton($("#preDnsClientFinalResponse"), "before", "#preDnsClientFinalResponse", "copy", "float: right; margin: 0 0 4px 0;");
    }

    function addCopyButton(anchor, position, targetSelector, label, style) {
        if (anchor.length === 0)
            return;

        var html = '<button type="button" class="copy-btn" data-copy-target="' + targetSelector + '" title="Copy to clipboard"' +
            (style == null ? "" : ' style="' + style + '"') + '>' + label + '</button>';

        if (position === "before")
            anchor.before(html);
        else
            anchor.after(html);
    }

    //The DNSSEC "View DS Info" table is built by upstream zone.js, so rather
    //than editing that function the cells are made click to copy. This depends
    //only on the tbody id, not on the row markup.
    function initDsClickToCopy() {
        $(document).on("click", "#tableDnssecViewDsBody td[style*='word-break']", function () {
            var text = $(this).text().replace(/^\s*Public Key\s*/, "").trim();

            if (text === "")
                return;

            copyText(text, null);
            showAlert("success", "Copied!", "Copied to the clipboard.", $("#divDnssecViewDsAlert"));
        });

        $(document).on("mouseenter", "#tableDnssecViewDsBody td[style*='word-break']", function () {
            $(this).css("cursor", "pointer").attr("title", "Click to copy");
        });
    }

    //any element with class copy-btn copies either the literal text in
    //data-copy-text or the text content of the element in data-copy-target
    function initClipboard() {
        $(document).on("click", ".copy-btn", function (e) {
            e.preventDefault();

            var button = $(this);
            var text = button.attr("data-copy-text");

            if (text == null) {
                var target = button.attr("data-copy-target");

                if (target != null) {
                    var element = $(target);
                    text = element.is("input, textarea, select") ? element.val() : element.text();
                }
            }

            if ((text == null) || (text === ""))
                return;

            copyText(text, this);
        });
    }

    // ----------------------------------------------------- most used zones

    //{ "example.com": { n: <times opened>, t: <last opened, ms> } }
    function readZoneUsage() {
        var usage = null;

        try {
            usage = JSON.parse(localStorage.getItem(ZONE_USAGE_KEY));
        }
        catch (e) {
            usage = null;
        }

        if ((usage != null) && (typeof usage === "object") && !Array.isArray(usage))
            return usage;

        return migrateRecentZones();
    }

    //this row replaced a dropdown that kept a plain most-recent-first list;
    //carry it over so the chips are useful immediately rather than in a week
    function migrateRecentZones() {
        var usage = {};

        try {
            var stored = JSON.parse(localStorage.getItem(RECENT_ZONES_KEY));

            if (Array.isArray(stored)) {
                for (var i = 0; i < stored.length; i++) {
                    //ordinals, not real timestamps: every migrated zone should lose
                    //a tie against one that has actually been opened since
                    if ((typeof stored[i] === "string") && (stored[i] !== ""))
                        usage[stored[i]] = { n: 1, t: stored.length - i };
                }
            }

            localStorage.removeItem(RECENT_ZONES_KEY);
            writeZoneUsage(usage);
        }
        catch (e) {
            //nothing to carry over
        }

        return usage;
    }

    function writeZoneUsage(usage) {
        try {
            localStorage.setItem(ZONE_USAGE_KEY, JSON.stringify(usage));
        }
        catch (e) {
            //storage full or disabled; the feature is optional
        }
    }

    //Most used first, most recent breaking ties, name last so the order is
    //never arbitrary. Ranking by count rather than by recency is what makes
    //this row worth aiming at: it only reorders when one zone genuinely
    //overtakes another, so a chip stays where the user last saw it.
    function rankZones(usage) {
        var names = [];

        for (var name in usage) {
            if ((usage[name] != null) && (usage[name].n > 0))
                names.push(name);
        }

        names.sort(function (a, b) {
            if (usage[b].n !== usage[a].n)
                return usage[b].n - usage[a].n;

            if (usage[b].t !== usage[a].t)
                return (usage[b].t || 0) - (usage[a].t || 0);

            return a.localeCompare(b);
        });

        return names;
    }

    function pruneZoneUsage(usage) {
        var names = rankZones(usage);

        if (names.length <= ZONE_USAGE_MAX)
            return usage;

        var pruned = {};

        for (var i = 0; i < ZONE_USAGE_MAX; i++)
            pruned[names[i]] = usage[names[i]];

        return pruned;
    }

    function rememberZone(zone) {
        if ((zone == null) || (zone === ""))
            return;

        //showEditZonePage also fires on every page and filter change inside a
        //zone, and counting those would make one long session look like heavy
        //use. Cleared when the zone list comes back, so reopening counts again.
        if (zone === zoneInView)
            return;

        zoneInView = zone;

        var usage = readZoneUsage();
        var entry = usage[zone];

        usage[zone] = { n: ((entry == null) || !(entry.n > 0)) ? 1 : entry.n + 1, t: Date.now() };

        writeZoneUsage(pruneZoneUsage(usage));
        renderZoneChips();
    }

    function forgetZone(zone) {
        var usage = readZoneUsage();

        delete usage[zone];

        if (zone === zoneInView)
            zoneInView = null;

        writeZoneUsage(usage);
        renderZoneChips();
    }

    function renderZoneChips() {
        var rows = $(".frequent-zones");

        if (rows.length === 0)
            return;

        var usage = readZoneUsage();
        var names = rankZones(usage);
        var html = "";

        //How many of these are actually visible is left to the stylesheet: the
        //cluster node selector beside the buttons is up to 250px wide and only
        //present on a cluster, so there is no fixed number that is right. The
        //row is one chip tall and clips whatever wraps past it.
        for (var i = 0; (i < names.length) && (i < ZONE_CHIPS_MAX); i++) {
            var times = usage[names[i]].n;
            var here = (zoneInView != null) && (names[i] === zoneInView);

            html += "<span class=\"zone-chip" + (here ? " active" : "") + "\">" +
                "<a href=\"#\" class=\"zone-chip-open\" data-zone=\"" + htmlEncode(names[i]) + "\" title=\"" + htmlEncode(names[i]) + " &mdash; opened " + times + (times === 1 ? " time" : " times") + "\">" + htmlEncode(names[i]) + "</a>" +
                "<a href=\"#\" class=\"zone-chip-forget\" data-zone=\"" + htmlEncode(names[i]) + "\" title=\"Remove " + htmlEncode(names[i]) + " from this row\">&times;</a>" +
                "</span>";
        }

        rows.html(html);
    }

    function initZoneChips() {
        $(document).on("click", ".zone-chip-open", function (e) {
            e.preventDefault();
            openZone($(this).attr("data-zone"));
        });

        $(document).on("click", ".zone-chip-forget", function (e) {
            e.preventDefault();
            e.stopPropagation();
            forgetZone($(this).attr("data-zone"));
        });

        renderZoneChips();
    }

    function openZone(zone) {
        if (!$("#mainPanelTabListZones").is(":visible"))
            return;

        $("#mainPanelTabListZones").children("a").first().tab("show");
        showEditZone(zone, 1, "", "");
    }

    // ---------------------------------------------------- remembered sizes

    //Page sizes are already remembered in localStorage by zone.js and logs.js,
    //but changing one only stored the preference: the table kept showing the old
    //number of rows until the user also found and pressed Go. Re-run the query
    //instead, from page one because the old page number no longer means the same
    //thing at a different page size.
    function initRememberedSelects() {
        $("#optZonesPerPage").on("change", function () {
            if ($("#divViewZones").is(":visible"))
                refreshZones(false, 1);
        });

        $("#optEditZoneRecordsPerPage").on("change", function () {
            if ($("#divEditZone").is(":visible"))
                showEditZonePage(1);
        });

        $("#optQueryLogsEntriesPerPage").on("change", function () {
            if ($("#divQueryLogsTable").is(":visible"))
                queryLogs(1);
        });
    }

    // ------------------------------------------------ unsaved settings guard

    function initSettingsGuard() {
        $("#mainPanelTabPaneSettings").on("input change", "input, select, textarea", function () {
            settingsDirty = true;
        });

        //a fresh load of the settings, including the reload that follows a
        //successful save, means there is nothing pending any more
        var originalLoadDnsSettings = window.loadDnsSettings;

        if (typeof originalLoadDnsSettings === "function") {
            window.loadDnsSettings = function () {
                var result = originalLoadDnsSettings.apply(this, arguments);
                settingsDirty = false;
                return result;
            };
        }

        $(document).on("show.bs.tab", 'a[data-toggle="tab"]', function (e) {
            if (!settingsDirty)
                return;

            if (!$("#mainPanelTabListSettings").hasClass("active"))
                return;

            var targetId = $(this).parent("li").attr("id");

            //moving between the settings sub tabs keeps the edits on screen
            if ((targetId == null) || (targetId.indexOf("mainPanelTabList") !== 0) || (targetId === "mainPanelTabListSettings"))
                return;

            if (window.confirm("You have unsaved changes in Settings. Leave the tab and discard them?"))
                settingsDirty = false;
            else
                e.preventDefault();
        });

        $(window).on("beforeunload", function (e) {
            if (!settingsDirty)
                return undefined;

            //modern browsers show their own wording; the string is only needed
            //to opt in to the prompt
            e.preventDefault();
            e.originalEvent.returnValue = "You have unsaved changes in Settings.";
            return "You have unsaved changes in Settings.";
        });
    }

    // ------------------------------------------------------ copy view link

    // ------------------------------------------------- zones search fallback

    //when a zone name filter finds nothing, offer to look inside the zones
    //instead of leaving the user at an empty table
    function initZonesSearchHint() {
        $(document).on("click", "#lnkZonesSearchRecords", function (e) {
            e.preventDefault();

            if (typeof GlobalSearch !== "undefined")
                GlobalSearch.open($("#txtZonesFilterName").val().trim());
        });

        var originalRefreshZones = window.refreshZones;

        if (typeof originalRefreshZones !== "function")
            return;

        //the zone table is filled asynchronously, so check once the response
        //has had a chance to land
        window.refreshZones = function () {
            var result = originalRefreshZones.apply(this, arguments);

            setTimeout(updateZonesSearchHint, 400);

            return result;
        };
    }

    function updateZonesSearchHint() {
        var hint = $("#divZonesSearchHint");

        if (hint.length === 0)
            return;

        var filter = $("#txtZonesFilterName").val().trim();

        if ((filter === "") || ($("#tableZonesBody tr").length > 0)) {
            hint.hide();
            return;
        }

        hint.html("No zone name matched <b>" + htmlEncode(filter) + "</b>. <a href=\"#\" id=\"lnkZonesSearchRecords\">Search inside the zones for records matching it</a>.").show();
    }

    // ------------------------------------------------------------------ init

    function init() {
        injectMarkup();
        initClipboard();
        initDsClickToCopy();
        initRememberedSelects();
        initSettingsGuard();
        initZonesSearchHint();
        initZoneChips();

        //showEditZonePage runs once the zone's records are in, so the zone name
        //it reads has already been normalised by the server
        var originalShowEditZonePage = window.showEditZonePage;

        if (typeof originalShowEditZonePage === "function") {
            window.showEditZonePage = function () {
                var result = originalShowEditZonePage.apply(this, arguments);

                try {
                    rememberZone($("#titleEditZone").attr("data-zone"));
                }
                catch (e) {
                    //never let this break the zone view
                }

                return result;
            };
        }

        //back on the zone list, so the visit is over and reopening the same
        //zone is a new one
        var originalRefreshZones = window.refreshZones;

        if (typeof originalRefreshZones === "function") {
            window.refreshZones = function () {
                zoneInView = null;
                renderZoneChips(); //drops the "you are here" marker

                return originalRefreshZones.apply(this, arguments);
            };
        }
    }

    return {
        init: init,
        copyText: copyText,
        openZone: openZone,

        //exposed for the regression tests and for anyone wanting to reset the row
        zoneUsage: function () {
            return rankZones(readZoneUsage());
        },

        forgetAllZones: function () {
            try {
                localStorage.removeItem(ZONE_USAGE_KEY);
                localStorage.removeItem(RECENT_ZONES_KEY);
            }
            catch (e) {
                //optional
            }

            renderZoneChips();
        }
    };
})();

$(function () {
    UX.init();
});
