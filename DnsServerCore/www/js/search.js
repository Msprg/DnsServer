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
// Global search.
//
// Searches record owner names, record data and comments across every zone the
// signed in user is allowed to view, using the api/zones/records/search
// endpoint. Picking a result opens the zone with the zone's own record filter
// already set to that record, which is what makes "find this one record"
// a single step instead of a hunt through the zone list.
//
// Typing anywhere outside a field opens this box, and does so scoped to the
// zone on screen when there is one, so "find that record" never starts with
// aiming at a search box.
//

var GlobalSearch = (function () {
    "use strict";

    var MIN_QUERY_LENGTH = 2;
    var DEBOUNCE_MS = 300;
    var MAX_RESULTS = 50;
    var DEFAULT_PLACEHOLDER = "Search zones & records...";

    var debounceHandle = null;
    var requestSequence = 0; //guards against an older response overwriting a newer one
    var lastQuery = null;
    var lastResponse = null;
    var lastScope = null;
    var activeScope = null; //zone the search is constrained to, or null for every zone

    function txtSearch() {
        return $("#txtGlobalSearch");
    }

    function divResults() {
        return $("#divGlobalSearchResults");
    }

    // ---------------------------------------------------------------- helpers

    //the zone record filter is relative to the zone, so example.com's
    //"www.example.com" has to be handed to it as "www", and its apex as "@"
    function toZoneRelativeName(recordName, zoneName) {
        if ((zoneName == null) || (zoneName === "") || (zoneName === "."))
            return ((recordName == null) || (recordName === "") || (recordName === ".")) ? "@" : recordName;

        if (recordName.toLowerCase() === zoneName.toLowerCase())
            return "@";

        var suffix = "." + zoneName;

        if ((recordName.length > suffix.length) && recordName.toLowerCase().endsWith(suffix.toLowerCase()))
            return recordName.substring(0, recordName.length - suffix.length);

        return recordName;
    }

    function formatRData(rData) {
        if (rData == null)
            return "";

        var parts = [];

        for (var key in rData) {
            if (key.length > 3 && key.substring(key.length - 3) === "Idn")
                continue; //the unicode twin of a field already listed

            var value = rData[key];

            if (value == null)
                continue;

            if (typeof value === "object")
                parts.push(key + "=" + JSON.stringify(value));
            else
                parts.push(String(value));
        }

        return parts.join(" ");
    }

    function escapeRegex(value) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    //highlights the part of the text the query matched; the input is already
    //html encoded by the caller
    function highlight(encodedText, query) {
        if ((query == null) || (query === ""))
            return encodedText;

        //wildcards are a matching feature, not something to highlight literally
        var needle = query.replace(/[*?]/g, "");

        if (needle.length < 1)
            return encodedText;

        try {
            return encodedText.replace(new RegExp("(" + escapeRegex(htmlEncode(needle)) + ")", "ig"), "<span class=\"global-search-hit\">$1</span>");
        }
        catch (e) {
            return encodedText;
        }
    }

    function currentNode() {
        var node = $("#optZonesClusterNode").val();
        return node == null ? "" : node;
    }

    // ------------------------------------------------------------------ scope

    //The zone editor's title carries the zone it is showing, and is only
    //meaningful while that editor is the pane actually on screen. Read at the
    //moment the box is opened rather than on every keystroke, so the scope
    //cannot shift under a search that is already being typed.
    function detectScope() {
        if (!$("#divEditZone").is(":visible"))
            return null;

        var zone = $("#titleEditZone").attr("data-zone");

        return (zone == null) ? null : zone;
    }

    function scopeLabel(zone) {
        return (zone === "") ? "." : zone;
    }

    function setScope(scope) {
        activeScope = scope;

        txtSearch().attr("placeholder", (scope == null) ? DEFAULT_PLACEHOLDER : "Search in " + scopeLabel(scope) + "...");
    }

    //shown above the results so the constraint is never invisible, and so there
    //is always one click back out to every zone
    function scopeHeaderHtml(scope) {
        return "<div class=\"global-search-group global-search-scope\">" +
            "<span>In " + htmlEncode(scopeLabel(scope)) + "</span>" +
            "<a href=\"#\" id=\"lnkGlobalSearchAllZones\">Search all zones</a>" +
            "</div>";
    }

    // -------------------------------------------------------------- rendering

    function showStatus(message, scope) {
        divResults().html(((scope == null) ? "" : scopeHeaderHtml(scope)) +
            "<div class=\"global-search-status\">" + htmlEncode(message) + "</div>").show();
    }

    function hide() {
        divResults().hide().empty();
    }

    function render(response, query, scope) {
        var zones = response.zones == null ? [] : response.zones;
        var results = response.results == null ? [] : response.results;

        if ((zones.length === 0) && (results.length === 0)) {
            showStatus("No zones or records matched “" + query + "”" + ((scope == null) ? "." : " in " + scopeLabel(scope) + "."), scope);
            return;
        }

        var html = (scope == null) ? "" : scopeHeaderHtml(scope);

        if (zones.length > 0) {
            html += "<div class=\"global-search-group\">Zones (" + zones.length + ")</div>";

            for (var i = 0; i < zones.length; i++) {
                var zoneName = zones[i].name === "" ? "." : zones[i].name;
                var zoneLabel = zones[i].nameIdn == null ? zoneName : zones[i].nameIdn + " (" + zoneName + ")";

                html += "<a class=\"global-search-item\" href=\"#\" data-kind=\"zone\" data-zone=\"" + htmlEncode(zones[i].name) + "\">" +
                    "<span class=\"global-search-name\">" + highlight(htmlEncode(zoneLabel), query) + "</span>" +
                    "<div class=\"global-search-meta\">" + htmlEncode(zones[i].type) + (zones[i].disabled ? " &middot; disabled" : "") + "</div>" +
                    "</a>";
            }
        }

        if (results.length > 0) {
            html += "<div class=\"global-search-group\">Records (" + results.length + (response.truncated ? "+" : "") + ")</div>";

            for (var j = 0; j < results.length; j++) {
                var result = results[j];
                var record = result.record;
                var recordName = record.name === "" ? "." : record.name;
                var rData = formatRData(record.rData);

                html += "<a class=\"global-search-item\" href=\"#\" data-kind=\"record\"" +
                    " data-zone=\"" + htmlEncode(result.zone) + "\"" +
                    " data-name=\"" + htmlEncode(record.name) + "\"" +
                    " data-type=\"" + htmlEncode(record.type) + "\">" +
                    "<span class=\"global-search-type\">" + htmlEncode(record.type) + "</span>" +
                    "<span class=\"global-search-name\">" + highlight(htmlEncode(recordName), query) + "</span>" +
                    "<div class=\"global-search-meta\">" + highlight(htmlEncode(rData), query) +
                    //naming the zone on every row is noise when every row is in the same one
                    ((scope == null) ? " &middot; in " + htmlEncode(result.zone === "" ? "." : result.zone) : "") +
                    (record.disabled ? " &middot; disabled" : "") + "</div>" +
                    "</a>";
            }
        }

        if (response.truncated)
            html += "<div class=\"global-search-status\">Showing the first " + MAX_RESULTS + " matches. Narrow the search to see the rest.</div>";

        divResults().html(html).show();
    }

    // ---------------------------------------------------------------- searching

    function search(query) {
        var sequence = ++requestSequence;
        var scope = activeScope; //pinned to this request, so a late response cannot render under a different scope

        lastQuery = query;
        lastScope = scope;

        var url = "api/zones/records/search?q=" + encodeURIComponent(query) + "&scope=all&maxResults=" + MAX_RESULTS + "&node=" + encodeURIComponent(currentNode());

        if (scope != null)
            url += "&zone=" + encodeURIComponent(scopeLabel(scope)) + "&zoneExact=true";

        HTTPRequest({
            url: url,
            token: sessionData.token,
            success: function (responseJSON) {
                if (sequence !== requestSequence)
                    return; //a newer search has already been issued

                lastResponse = responseJSON.response;
                render(responseJSON.response, query, scope);
            },
            error: function () {
                if (sequence !== requestSequence)
                    return;

                showStatus("Search failed. The server may be running a build without the record search API.", scope);
            },
            invalidToken: function () {
                showPageLogin();
            },
            dontHideAlert: true
        });

        showStatus("Searching…", scope);
    }

    function scheduleSearch() {
        if (debounceHandle != null) {
            clearTimeout(debounceHandle);
            debounceHandle = null;
        }

        var query = txtSearch().val().trim();

        $("#lnkGlobalSearchClear").css("display", query.length > 0 ? "block" : "none");

        if (query.length < MIN_QUERY_LENGTH) {
            requestSequence++; //discard anything still in flight

            //typing the first character has to acknowledge itself, otherwise
            //type-to-search looks like it swallowed the keystroke
            if (query.length > 0)
                showStatus("Keep typing to search…", activeScope);
            else
                hide();

            return;
        }

        debounceHandle = setTimeout(function () {
            debounceHandle = null;
            search(query);
        }, DEBOUNCE_MS);
    }

    // ---------------------------------------------------------------- picking

    function openResult(item) {
        var zone = item.attr("data-zone");

        if (zone === "")
            zone = ".";

        hide();

        if (!$("#mainPanelTabListZones").is(":visible")) {
            showAlert("warning", "Not Allowed!", "You do not have permission to view zones.");
            return;
        }

        //bring the Zones tab forward without letting its own refresh race the
        //zone we are about to open
        $("#mainPanelTabListZones").children("a").first().tab("show");

        if (item.attr("data-kind") === "zone") {
            showEditZone(zone, 1, "", "");
            return;
        }

        showEditZone(zone, 1, toZoneRelativeName(item.attr("data-name"), item.attr("data-zone")), item.attr("data-type"));
    }

    function moveSelection(delta) {
        var items = divResults().find(".global-search-item");

        if (items.length === 0)
            return;

        var index = items.index(items.filter(".active"));

        index += delta;

        if (index < 0)
            index = items.length - 1;
        else if (index >= items.length)
            index = 0;

        items.removeClass("active");

        var selected = items.eq(index);
        selected.addClass("active");

        var container = divResults()[0];
        var element = selected[0];

        if (element.offsetTop < container.scrollTop)
            container.scrollTop = element.offsetTop;
        else if ((element.offsetTop + element.offsetHeight) > (container.scrollTop + container.clientHeight))
            container.scrollTop = element.offsetTop + element.offsetHeight - container.clientHeight;
    }

    // -------------------------------------------------------- type to search

    function isTypingTarget(target) {
        if (target == null)
            return false;

        var tag = (target.tagName == null) ? "" : target.tagName.toLowerCase();

        return (tag === "input") || (tag === "textarea") || (tag === "select") || (target.isContentEditable === true);
    }

    //Typing anywhere that is not a field goes to the search box, the way it
    //does in a file manager.
    //
    //Note that this deliberately does not route into the Cached/Allowed/Blocked
    //domain boxes, tempting as that is: Enter in the Allowed and Blocked ones
    //adds the domain to the list with no confirmation, whereas Enter here means
    //"open the highlighted result". Sending stray keystrokes somewhere that
    //Enter has a destructive meaning is not worth the consistency.
    function initTypeToSearch() {
        $(document).on("keydown", function (e) {
            if (e.ctrlKey || e.metaKey || e.altKey)
                return;

            if (isTypingTarget(e.target))
                return;

            //not on the login page, and not while a dialog has the user's attention
            if (!$("#pageMain").is(":visible") || $("body").hasClass("modal-open"))
                return;

            var input = txtSearch();

            if (input.length === 0)
                return;

            var seed;

            if (e.key === "/")
                seed = ""; //the usual "just focus the search" key
            else if ((typeof e.key === "string") && (e.key.length === 1) && !/\s/.test(e.key))
                seed = e.key;
            else
                return;

            e.preventDefault(); //or the browser types the character in as well, giving "ww" for one "w"

            setScope(detectScope());

            input.val(seed);
            input.trigger("focus");

            //some browsers select the whole value when an input takes focus, which
            //would make the next keystroke replace the one that opened the box
            if (typeof input[0].setSelectionRange === "function")
                input[0].setSelectionRange(seed.length, seed.length);

            scheduleSearch();
        });
    }

    // ------------------------------------------------------------------- init

    function init() {
        var input = txtSearch();

        if (input.length === 0)
            return;

        input.on("input", scheduleSearch);

        input.on("focus", function () {
            //an empty box is a fresh search, so it picks up wherever the user is now
            if (input.val() === "") {
                setScope(detectScope());
                return;
            }

            if ((lastResponse != null) && (input.val().trim() === lastQuery) && (lastQuery != null) && (lastQuery.length >= MIN_QUERY_LENGTH))
                render(lastResponse, lastQuery, lastScope);
        });

        input.on("keydown", function (e) {
            switch (e.which) {
                case 27: //escape
                    hide();
                    input.trigger("blur");
                    break;

                case 38: //up
                    if (divResults().is(":visible")) {
                        moveSelection(-1);
                        e.preventDefault();
                    }
                    break;

                case 40: //down
                    if (divResults().is(":visible")) {
                        moveSelection(1);
                        e.preventDefault();
                    }
                    break;

                case 13: //enter
                    {
                        var selected = divResults().find(".global-search-item.active");

                        if (selected.length === 0)
                            selected = divResults().find(".global-search-item").first();

                        if (selected.length > 0)
                            openResult(selected);

                        e.preventDefault();
                    }
                    break;
            }
        });

        $("#lnkGlobalSearchClear").on("click", function () {
            input.val("");
            scheduleSearch();
            input.trigger("focus");
        });

        divResults().on("click", ".global-search-item", function (e) {
            e.preventDefault();
            openResult($(this));
        });

        divResults().on("click", "#lnkGlobalSearchAllZones", function (e) {
            e.preventDefault();
            e.stopPropagation();

            setScope(null);
            lastResponse = null; //scoped results, no longer what is being asked for
            scheduleSearch();
            input.trigger("focus");
        });

        divResults().on("mouseenter", ".global-search-item", function () {
            divResults().find(".global-search-item").removeClass("active");
            $(this).addClass("active");
        });

        //clicking anywhere else dismisses the results
        $(document).on("mousedown", function (e) {
            if ($(e.target).closest("#divGlobalSearch").length === 0)
                hide();
        });

        initTypeToSearch();
    }

    return {
        init: init,

        //used by the "search records instead" hint on the Zones tab
        open: function (query) {
            var input = txtSearch();

            if (input.length === 0)
                return;

            setScope(detectScope());

            input.val(query);
            input.trigger("focus");
            scheduleSearch();
        },

        reset: function () {
            requestSequence++;
            lastQuery = null;
            lastResponse = null;
            lastScope = null;
            setScope(null);
            txtSearch().val("");
            $("#lnkGlobalSearchClear").hide();
            hide();
        }
    };
})();

$(function () {
    GlobalSearch.init();
});
