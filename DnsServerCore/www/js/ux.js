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
//   - a "recently visited zones" list
//   - a "copy link to this view" button that pairs with the URL routing
//   - remembering how many rows per page the user likes
//   - a warning before walking away from unsaved DNS settings
//
// Like the router, this file wraps the existing view functions from the
// outside rather than editing them, so that upstream changes stay mergeable.
//

var UX = (function () {
    "use strict";

    var RECENT_ZONES_KEY = "recentZones";
    var RECENT_ZONES_MAX = 10;

    var settingsDirty = false;

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
        //global search + "copy link to this view", in the page header
        var updateLink = $("#lnkUpdateAvailable");

        if (updateLink.length > 0) {
            updateLink.css("margin-right", "10px").after(
                '<div id="divGlobalSearch" class="global-search">' +
                '<input type="text" id="txtGlobalSearch" class="form-control" placeholder="Search zones &amp; records..." autocomplete="off" spellcheck="false" aria-label="Search zones and records" />' +
                '<span id="lnkGlobalSearchClear" class="global-search-clear" title="Clear search">&times;</span>' +
                '<div id="divGlobalSearchResults" class="global-search-results"></div>' +
                '</div>' +
                '<a href="#" id="lnkCopyViewLink" title="Copy a link to this view" style="margin-left: 8px;"><span class="glyphicon glyphicon-link" aria-hidden="true"></span></a>');
        }

        //recent zones, in the zone list toolbar
        var zonesToolbar = $("#optZonesClusterNode").closest(".form-inline");

        if (zonesToolbar.length > 0) {
            zonesToolbar.prepend(
                '<div class="pull-left">' +
                '<div class="form-group dropdown" style="margin-right: 0px;">' +
                '<button type="button" class="btn btn-default dropdown-toggle" style="padding: 2px 10px;" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false">Recent Zones <span class="caret"></span></button>' +
                '<ul id="ulRecentZones" class="dropdown-menu recent-zones-menu"></ul>' +
                '</div></div>');
        }

        //"search inside the zones instead" hint, above the zone table
        $('<div id="divZonesSearchHint" class="zones-search-hint" style="display: none;"></div>').insertBefore("#tableZones");

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

    // -------------------------------------------------------- recent zones

    function readRecentZones() {
        try {
            var stored = localStorage.getItem(RECENT_ZONES_KEY);

            if (stored == null)
                return [];

            var zones = JSON.parse(stored);

            return Array.isArray(zones) ? zones : [];
        }
        catch (e) {
            return [];
        }
    }

    function rememberZone(zone) {
        if ((zone == null) || (zone === ""))
            return;

        var zones = readRecentZones();
        var updated = [zone];

        for (var i = 0; (i < zones.length) && (updated.length < RECENT_ZONES_MAX); i++) {
            if (zones[i] !== zone)
                updated.push(zones[i]);
        }

        try {
            localStorage.setItem(RECENT_ZONES_KEY, JSON.stringify(updated));
        }
        catch (e) {
            //storage full or disabled; the feature is optional
        }

        renderRecentZones();
    }

    function renderRecentZones() {
        var menu = $("#ulRecentZones");

        if (menu.length === 0)
            return;

        var zones = readRecentZones();

        if (zones.length === 0) {
            menu.html("<li class=\"disabled\"><a href=\"#\" onclick=\"return false;\">No zones visited yet</a></li>");
            return;
        }

        var html = "";

        for (var i = 0; i < zones.length; i++)
            html += "<li><a href=\"#\" onclick=\"UX.openRecentZone(" + JSON.stringify(zones[i]).replace(/"/g, "&quot;") + "); return false;\">" + htmlEncode(zones[i]) + "</a></li>";

        html += "<li role=\"separator\" class=\"divider\"></li>";
        html += "<li><a href=\"#\" onclick=\"UX.clearRecentZones(); return false;\">Clear list</a></li>";

        menu.html(html);
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

    function initCopyLink() {
        $("#lnkCopyViewLink").on("click", function (e) {
            e.preventDefault();

            if (typeof Router === "undefined")
                return;

            copyText(Router.url(), this);
            showAlert("success", "Copied!", "A link to this view has been copied to the clipboard.");
        });
    }

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
        initCopyLink();
        initZonesSearchHint();

        renderRecentZones();

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
    }

    return {
        init: init,
        copyText: copyText,

        openRecentZone: function (zone) {
            if (!$("#mainPanelTabListZones").is(":visible"))
                return;

            $("#mainPanelTabListZones").children("a").first().tab("show");
            showEditZone(zone, 1, "", "");
        },

        clearRecentZones: function () {
            try {
                localStorage.removeItem(RECENT_ZONES_KEY);
            }
            catch (e) {
                //optional
            }

            renderRecentZones();
        }
    };
})();

$(function () {
    UX.init();
});
