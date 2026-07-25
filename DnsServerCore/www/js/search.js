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
// Two separate search mechanisms.
//
// GlobalSearch is the box in the page header. It is always global: it asks
// api/zones/records/search about every zone the signed in user may view, and
// picking a result opens that zone with its record filter already narrowed to
// the record. Never scoped to anything - if it is on screen, it searches
// everything.
//
// ZoneSearch is the zone editor's own filter, the one sharing a row with the
// page number and records per page. It never leaves the zone it is in, works
// entirely on the records already loaded in the browser, and filters the table
// as the user types.
//
// Typing anywhere outside a field goes to whichever of the two the user is
// standing in front of: the zone's filter while a zone is open, the header box
// otherwise.
//

(function () {
    "use strict";

    // ----------------------------------------------------------- shared bits

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

    //flattens a record's rData, however nested, into something searchable and
    //printable
    function flatten(value) {
        if (value == null)
            return "";

        if (typeof value !== "object")
            return String(value);

        var parts = [];

        for (var key in value) {
            if ((key.length > 3) && (key.substring(key.length - 3) === "Idn"))
                continue; //the unicode twin of a field already listed

            var text = flatten(value[key]);

            if (text !== "")
                parts.push(text);
        }

        return parts.join(" ");
    }

    function caretToEnd(box) {
        if ((box.length > 0) && (typeof box[0].setSelectionRange === "function"))
            box[0].setSelectionRange(box.val().length, box.val().length);
    }

    // =========================================================== zone search

    var ZoneSearch = (function () {
        var DEBOUNCE_MS = 150;

        var debounceHandle = null;

        function input() {
            return $("#txtEditZoneFilterName");
        }

        function typeInput() {
            return $("#txtEditZoneFilterType");
        }

        //the zone editor is the pane on screen, so keystrokes belong here
        function isActive() {
            return $("#divEditZone").is(":visible") && (input().length > 0);
        }

        // --------------------------------------------------------- matching

        //Upstream treats a filter with no * or ? in it as an exact match on the
        //whole name, which makes finding a record a guessing game about where
        //to put the stars. Those filters are reinterpreted here as a substring
        //search; anything that does contain a wildcard is left to upstream, so
        //existing filters and bookmarked URLs keep behaving as they did.
        function isWildcard(query) {
            return (query.indexOf("*") > -1) || (query.indexOf("?") > -1);
        }

        function haystack(record, zone) {
            return (toZoneRelativeName(record.name, zone) + " " +
                record.name + " " +
                record.type + " " +
                record.ttl + " " +
                flatten(record.rData) + " " +
                (record.comments == null ? "" : record.comments)).toLowerCase();
        }

        //space separated terms all have to match, which is what makes
        //"www a 10.0" a useful thing to type
        function terms(query) {
            var raw = query.toLowerCase().split(/\s+/);
            var out = [];

            for (var i = 0; i < raw.length; i++) {
                if (raw[i] !== "")
                    out.push(raw[i]);
            }

            return out;
        }

        function matches(text, wanted) {
            for (var i = 0; i < wanted.length; i++) {
                if (text.indexOf(wanted[i]) < 0)
                    return false;
            }

            return true;
        }

        //Upstream's showEditZonePage() only builds editZoneFilteredRecords when
        //it finds it null, so filling it in beforehand is all it takes to change
        //what the table shows - the paging, the row rendering and the edit paths
        //that write back through record.index are all left alone.
        function applyFilter() {
            var records = window.editZoneRecords;

            if ((records == null) || (records.length == null))
                return;

            var query = input().val();

            if ((query == null) || (query.trim() === "") || isWildcard(query))
                return; //nothing to do, or upstream's own semantics

            var wanted = terms(query);
            var filterType = typeInput().val().trim().toUpperCase();
            var zone = $("#titleEditZone").attr("data-zone");
            var filtered = [];

            for (var i = 0; i < records.length; i++) {
                var record = records[i];

                record.index = i; //keep original index for update tasks, as upstream does

                if ((filterType !== "") && (record.type !== filterType))
                    continue;

                if (!matches(haystack(record, zone), wanted))
                    continue;

                filtered.push(record);
            }

            window.editZoneFilteredRecords = filtered;
        }

        // ------------------------------------------------------------ wiring

        function installFilterHook() {
            var original = window.showEditZonePage;

            if (typeof original !== "function")
                return;

            window.showEditZonePage = function () {
                try {
                    if (window.editZoneFilteredRecords == null)
                        applyFilter();
                }
                catch (e) {
                    //a broken filter must never take the zone editor down with it
                }

                return original.apply(this, arguments);
            };
        }

        function rerender() {
            if (debounceHandle != null) {
                clearTimeout(debounceHandle);
                debounceHandle = null;
            }

            debounceHandle = setTimeout(function () {
                debounceHandle = null;

                if (!isActive())
                    return;

                window.editZoneFilteredRecords = null; //upstream's own input handler does this too, but do not rely on handler order

                //the result set just changed, so any other page number is meaningless
                showEditZonePage(1);
            }, DEBOUNCE_MS);
        }

        function init() {
            installFilterHook();

            input().on("input", rerender);
            typeInput().on("input", rerender);

            //the box matches values and comments as well now, so "Name" would be a lie
            $("label[for='txtEditZoneFilterName']").text("Search");
            input().attr("placeholder", "name, type, value or comment");
        }

        return {
            init: init,
            isActive: isActive,

            canSeed: function () {
                return input().length > 0;
            },

            seed: function (text) {
                var box = input();

                box.val(text);
                box.trigger("focus");
                caretToEnd(box);
                box.trigger("input");
            }
        };
    })();

    // ========================================================= global search

    var GlobalSearch = (function () {
        var MIN_QUERY_LENGTH = 2;
        var DEBOUNCE_MS = 300;
        var MAX_RESULTS = 50;

        var debounceHandle = null;
        var requestSequence = 0; //guards against an older response overwriting a newer one
        var lastQuery = null;
        var lastResponse = null;

        function txtSearch() {
            return $("#txtGlobalSearch");
        }

        function divResults() {
            return $("#divGlobalSearchResults");
        }

        // ---------------------------------------------------------- helpers

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

        // ------------------------------------------------------- rendering

        function showStatus(message) {
            divResults().html("<div class=\"global-search-status\">" + htmlEncode(message) + "</div>").show();
        }

        function hide() {
            divResults().hide().empty();
        }

        function render(response, query) {
            var zones = response.zones == null ? [] : response.zones;
            var results = response.results == null ? [] : response.results;

            if ((zones.length === 0) && (results.length === 0)) {
                showStatus("No zones or records matched “" + query + "”.");
                return;
            }

            var html = "";

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

                    html += "<a class=\"global-search-item\" href=\"#\" data-kind=\"record\"" +
                        " data-zone=\"" + htmlEncode(result.zone) + "\"" +
                        " data-name=\"" + htmlEncode(record.name) + "\"" +
                        " data-type=\"" + htmlEncode(record.type) + "\">" +
                        "<span class=\"global-search-type\">" + htmlEncode(record.type) + "</span>" +
                        "<span class=\"global-search-name\">" + highlight(htmlEncode(recordName), query) + "</span>" +
                        "<div class=\"global-search-meta\">" + highlight(htmlEncode(flatten(record.rData)), query) +
                        " &middot; in " + htmlEncode(result.zone === "" ? "." : result.zone) +
                        (record.disabled ? " &middot; disabled" : "") + "</div>" +
                        "</a>";
                }
            }

            if (response.truncated)
                html += "<div class=\"global-search-status\">Showing the first " + MAX_RESULTS + " matches. Narrow the search to see the rest.</div>";

            divResults().html(html).show();
        }

        // ------------------------------------------------------- searching

        function search(query) {
            var sequence = ++requestSequence;

            lastQuery = query;

            HTTPRequest({
                url: "api/zones/records/search?q=" + encodeURIComponent(query) + "&scope=all&maxResults=" + MAX_RESULTS + "&node=" + encodeURIComponent(currentNode()),
                token: sessionData.token,
                success: function (responseJSON) {
                    if (sequence !== requestSequence)
                        return; //a newer search has already been issued

                    lastResponse = responseJSON.response;
                    render(responseJSON.response, query);
                },
                error: function () {
                    if (sequence !== requestSequence)
                        return;

                    showStatus("Search failed. The server may be running a build without the record search API.");
                },
                invalidToken: function () {
                    showPageLogin();
                },
                dontHideAlert: true
            });

            showStatus("Searching…");
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
                    showStatus("Keep typing to search…");
                else
                    hide();

                return;
            }

            debounceHandle = setTimeout(function () {
                debounceHandle = null;
                search(query);
            }, DEBOUNCE_MS);
        }

        function clear() {
            requestSequence++;
            lastQuery = null;
            lastResponse = null;

            txtSearch().val("");
            $("#lnkGlobalSearchClear").hide();
            hide();
        }

        // --------------------------------------------------------- picking

        function openResult(item) {
            var zone = item.attr("data-zone");

            if (zone === "")
                zone = ".";

            //Emptied on the way out, not left sitting there: the search is over,
            //and whatever gets typed next is a new one. Leaving the old query in
            //place meant the next keystrokes were appended to it.
            clear();

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

        // ------------------------------------------------------------ init

        function init() {
            var input = txtSearch();

            if (input.length === 0)
                return;

            input.on("input", scheduleSearch);

            input.on("focus", function () {
                if ((lastResponse != null) && (input.val().trim() === lastQuery) && (lastQuery != null) && (lastQuery.length >= MIN_QUERY_LENGTH))
                    render(lastResponse, lastQuery);
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
                clear();
                input.trigger("focus");
            });

            divResults().on("click", ".global-search-item", function (e) {
                e.preventDefault();
                openResult($(this));
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
        }

        return {
            init: init,
            reset: clear,

            canSeed: function () {
                return txtSearch().length > 0;
            },

            seed: function (text) {
                var box = txtSearch();

                box.val(text);
                box.trigger("focus");
                caretToEnd(box);
                scheduleSearch();
            },

            //used by the "search records instead" hint on the Zones tab
            open: function (query) {
                var box = txtSearch();

                if (box.length === 0)
                    return;

                box.val(query);
                box.trigger("focus");
                scheduleSearch();
            }
        };
    })();

    // ======================================================== type to search

    function isTypingTarget(target) {
        if (target == null)
            return false;

        var tag = (target.tagName == null) ? "" : target.tagName.toLowerCase();

        return (tag === "input") || (tag === "textarea") || (tag === "select") || (target.isContentEditable === true);
    }

    //Typing anywhere that is not a field goes to a search box, the way it does
    //in a file manager. Which box is the whole point: standing in a zone, the
    //keystrokes belong to that zone's filter, not to a search of the entire
    //server.
    //
    //Note that this deliberately never routes into the Cached, Allowed or
    //Blocked domain boxes, tempting as that is: Enter in the Allowed and Blocked
    //ones adds the domain to the list with no confirmation. Sending stray
    //keystrokes somewhere that Enter is destructive is not worth the
    //consistency.
    function initTypeToSearch() {
        $(document).on("keydown", function (e) {
            if (e.ctrlKey || e.metaKey || e.altKey)
                return;

            if (isTypingTarget(e.target))
                return;

            //not on the login page, and not while a dialog has the user's attention
            if (!$("#pageMain").is(":visible") || $("body").hasClass("modal-open"))
                return;

            var seed;

            if (e.key === "/")
                seed = ""; //the usual "just focus the search" key
            else if ((typeof e.key === "string") && (e.key.length === 1) && !/\s/.test(e.key))
                seed = e.key;
            else
                return;

            var target = ZoneSearch.isActive() ? ZoneSearch : GlobalSearch;

            if (!target.canSeed())
                return;

            e.preventDefault(); //or the browser types the character in as well, giving "ww" for one "w"

            target.seed(seed);
        });
    }

    window.ZoneSearch = ZoneSearch;
    window.GlobalSearch = GlobalSearch;

    $(function () {
        //ZoneSearch first: it wraps showEditZonePage, and wants to sit inside
        //the wrappers the router and ux.js have already put around it
        ZoneSearch.init();
        GlobalSearch.init();
        initTypeToSearch();
    });
})();
