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

var GlobalSearch = (function () {
    "use strict";

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

    // -------------------------------------------------------------- rendering

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
                var rData = formatRData(record.rData);

                html += "<a class=\"global-search-item\" href=\"#\" data-kind=\"record\"" +
                    " data-zone=\"" + htmlEncode(result.zone) + "\"" +
                    " data-name=\"" + htmlEncode(record.name) + "\"" +
                    " data-type=\"" + htmlEncode(record.type) + "\">" +
                    "<span class=\"global-search-type\">" + htmlEncode(record.type) + "</span>" +
                    "<span class=\"global-search-name\">" + highlight(htmlEncode(recordName), query) + "</span>" +
                    "<div class=\"global-search-meta\">" + highlight(htmlEncode(rData), query) + " &middot; in " + htmlEncode(result.zone === "" ? "." : result.zone) + (record.disabled ? " &middot; disabled" : "") + "</div>" +
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

    // ------------------------------------------------------------------- init

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
            input.val("");
            scheduleSearch();
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

        //used by the "search records instead" hint on the Zones tab
        open: function (query) {
            var input = txtSearch();

            if (input.length === 0)
                return;

            input.val(query);
            input.trigger("focus");
            scheduleSearch();
        },

        reset: function () {
            requestSequence++;
            lastQuery = null;
            lastResponse = null;
            txtSearch().val("");
            $("#lnkGlobalSearchClear").hide();
            hide();
        }
    };
})();

$(function () {
    GlobalSearch.init();
});
