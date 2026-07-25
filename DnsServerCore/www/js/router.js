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
// URL routing for the web console.
//
// Keeps the address bar in sync with the view that is on screen so that a
// reload, a bookmark or a "duplicate tab" lands back where the user was, and
// so that the browser back/forward buttons behave the way they do on any
// other web app.
//
// State is carried in the query string of the existing path (History API), so
// no server side route/rewrite is needed and the SSO callback - which uses
// location.hash - is left alone.
//
// This file deliberately does not modify the existing view functions. It wraps
// them from the outside so that upstream changes stay easy to merge.
//

var Router = (function () {
    "use strict";

    //main panel tabs: route key -> id suffix used by mainPanelTabList*/mainPanelTabPane*
    var MAIN_TABS = [
        { key: "dashboard", id: "Dashboard" },
        { key: "zones", id: "Zones" },
        { key: "cache", id: "CachedZones" },
        { key: "allowed", id: "AllowedZones" },
        { key: "blocked", id: "BlockedZones" },
        { key: "apps", id: "Apps" },
        { key: "dnsclient", id: "DnsClient" },
        { key: "settings", id: "Settings", group: "settings" },
        { key: "dhcp", id: "Dhcp", group: "dhcp" },
        { key: "admin", id: "Admin", group: "admin" },
        { key: "logs", id: "Logs", group: "logs" },
        { key: "about", id: "About" }
    ];

    //nested tabs: group -> route key -> id suffix used by <group>TabList*/<group>TabPane*
    var SUB_TABS = {
        settings: [
            { key: "general", id: "General" },
            { key: "webservice", id: "WebService" },
            { key: "protocols", id: "OptionalProtocols" },
            { key: "tsig", id: "Tsig" },
            { key: "recursion", id: "Recursion" },
            { key: "cache", id: "Cache" },
            { key: "blocking", id: "Blocking" },
            { key: "forwarders", id: "ProxyForwarders" },
            { key: "logging", id: "Logging" }
        ],
        dhcp: [
            { key: "leases", id: "Leases" },
            { key: "scopes", id: "Scopes" }
        ],
        admin: [
            { key: "sessions", id: "Sessions" },
            { key: "users", id: "Users" },
            { key: "groups", id: "Groups" },
            { key: "permissions", id: "Permissions" },
            { key: "sso", id: "Sso" },
            { key: "cluster", id: "Cluster" }
        ],
        logs: [
            { key: "view", id: "LogViewer" },
            { key: "query", id: "QueryLogs" }
        ]
    };

    //permission section guarding each main tab; null means always available
    var TAB_PERMISSION = {
        dashboard: "Dashboard",
        zones: "Zones",
        cache: "Cache",
        allowed: "Allowed",
        blocked: "Blocked",
        apps: "Apps",
        dnsclient: "DnsClient",
        settings: "Settings",
        dhcp: "DhcpServer",
        admin: "Administration",
        logs: "Logs",
        about: null
    };

    var suppressDepth = 0; //while > 0, view changes are applied without being recorded
    var started = false; //true once the main page is up and recording is allowed
    var currentState = null; //last state written to the address bar

    // ---------------------------------------------------------------- helpers

    function findMainTab(key) {
        for (var i = 0; i < MAIN_TABS.length; i++) {
            if (MAIN_TABS[i].key === key)
                return MAIN_TABS[i];
        }

        return null;
    }

    function findMainTabByElementId(elementId) {
        for (var i = 0; i < MAIN_TABS.length; i++) {
            if ("mainPanelTabList" + MAIN_TABS[i].id === elementId)
                return MAIN_TABS[i];
        }

        return null;
    }

    function findSubTab(group, key) {
        var list = SUB_TABS[group];
        if (list == null)
            return null;

        for (var i = 0; i < list.length; i++) {
            if (list[i].key === key)
                return list[i];
        }

        return null;
    }

    function findSubTabByElementId(elementId) {
        for (var group in SUB_TABS) {
            var list = SUB_TABS[group];

            for (var i = 0; i < list.length; i++) {
                if (group + "TabList" + list[i].id === elementId)
                    return { group: group, tab: list[i] };
            }
        }

        return null;
    }

    function activeSubTabKey(group) {
        var list = SUB_TABS[group];
        if (list == null)
            return null;

        for (var i = 0; i < list.length; i++) {
            if ($("#" + group + "TabList" + list[i].id).hasClass("active"))
                return list[i].key;
        }

        return null;
    }

    function activeMainTabKey() {
        for (var i = 0; i < MAIN_TABS.length; i++) {
            if ($("#mainPanelTabList" + MAIN_TABS[i].id).hasClass("active"))
                return MAIN_TABS[i].key;
        }

        return null;
    }

    function canView(tabKey) {
        var section = TAB_PERMISSION[tabKey];
        if (section == null)
            return true;

        if ((sessionData == null) || (sessionData.info == null) || (sessionData.info.permissions == null))
            return false;

        var permission = sessionData.info.permissions[section];
        return (permission != null) && permission.canView;
    }

    //splits "settings.recursion" into { tab: "settings", sub: "recursion" }
    function splitRoute(t) {
        if (t == null)
            return { tab: null, sub: null };

        var i = t.indexOf(".");
        if (i < 0)
            return { tab: t, sub: null };

        return { tab: t.substring(0, i), sub: t.substring(i + 1) };
    }

    // -------------------------------------------------------------- url <-> state

    function parseUrl() {
        var params = new URLSearchParams(window.location.search);
        var t = params.get("t");

        if ((t == null) || (t === ""))
            return null;

        var state = { t: t };

        params.forEach(function (value, key) {
            if (key !== "t")
                state[key] = value;
        });

        return state;
    }

    function buildUrl(state) {
        if ((state == null) || (state.t == null))
            return window.location.pathname;

        var params = new URLSearchParams();
        params.set("t", state.t);

        for (var key in state) {
            if (key === "t")
                continue;

            var value = state[key];
            if ((value == null) || (value === ""))
                continue;

            params.set(key, value);
        }

        return window.location.pathname + "?" + params.toString();
    }

    //identity of the "place" a state points at; used to decide whether a
    //navigation deserves its own history entry or should just refine the
    //current one (paging and filtering should not flood the back button)
    function placeKey(state) {
        if (state == null)
            return "";

        var key = state.t;

        switch (splitRoute(state.t).tab) {
            case "zones":
                key += "|" + (state.zone == null ? "" : state.zone);
                break;

            case "cache":
            case "allowed":
            case "blocked":
                key += "|" + (state.d == null ? "" : state.d);
                break;

            case "dhcp":
                key += "|" + (state.scope == null ? "" : state.scope);
                break;

            case "logs":
                key += "|" + (state.f == null ? "" : state.f);
                break;
        }

        return key;
    }

    // ------------------------------------------------------------- recording

    function record(state, forceReplace) {
        if (!started || (suppressDepth > 0) || (state == null))
            return;

        var url = buildUrl(state);

        if (url === (window.location.pathname + window.location.search)) {
            currentState = state;
            return;
        }

        if (forceReplace || (placeKey(state) === placeKey(currentState)))
            window.history.replaceState(state, "", url);
        else
            window.history.pushState(state, "", url);

        currentState = state;

        $(document).trigger("router:changed", [state]);
    }

    //builds the state for whatever is currently on screen
    function captureCurrent() {
        var tabKey = activeMainTabKey();
        if (tabKey == null)
            return null;

        var tab = findMainTab(tabKey);
        var state = { t: tabKey };

        if (tab.group != null) {
            var sub = activeSubTabKey(tab.group);
            if (sub != null)
                state.t = tabKey + "." + sub;
        }

        var capture = CAPTURE[tabKey];
        if (capture != null)
            capture(state);

        return state;
    }

    function recordCurrent(forceReplace) {
        record(captureCurrent(), forceReplace);
    }

    //per tab collection of the parameters worth putting in the URL
    var CAPTURE = {
        dashboard: function (state) {
            var range = $("input[name=rdStatType]:checked").val();

            setIfMeaningful(state, "range", range, "lastHour");

            if (range === "custom") {
                setIfMeaningful(state, "start", $("#dpCustomDayWiseStart").val());
                setIfMeaningful(state, "end", $("#dpCustomDayWiseEnd").val());
            }
        },

        zones: function (state) {
            if ($("#divEditZone").is(":visible")) {
                var zone = $("#titleEditZone").attr("data-zone");
                if ((zone != null) && (zone !== ""))
                    state.zone = zone;

                setIfMeaningful(state, "p", $("#txtEditZonePageNumber").val(), "1");
                setIfMeaningful(state, "fn", $("#txtEditZoneFilterName").val());
                setIfMeaningful(state, "ft", $("#txtEditZoneFilterType").val());
            }
            else {
                setIfMeaningful(state, "p", $("#txtZonesPageNumber").val(), "1");
                setIfMeaningful(state, "fn", $("#txtZonesFilterName").val());
                setIfMeaningful(state, "ft", $("#optZonesFilterType").val());
            }
        },

        cache: function (state) {
            setIfMeaningful(state, "d", currentTreeDomain("#txtCachedZoneViewerTitle"));
        },

        allowed: function (state) {
            setIfMeaningful(state, "d", currentTreeDomain("#txtAllowedZoneViewerTitle"));
        },

        blocked: function (state) {
            setIfMeaningful(state, "d", currentTreeDomain("#txtBlockedZoneViewerTitle"));
        },

        dnsclient: function (state) {
            setIfMeaningful(state, "s", $("#txtDnsClientNameServer").val(), "This Server {this-server}");
            setIfMeaningful(state, "d", $("#txtDnsClientDomain").val());
            setIfMeaningful(state, "type", $("#optDnsClientType").val(), "A");
            setIfMeaningful(state, "proto", $("#optDnsClientProtocol").val(), "UDP");
            setIfMeaningful(state, "ecs", $("#txtDnsClientEDnsClientSubnet").val());

            if ($("#chkDnsClientDnssecValidation").prop("checked"))
                state.dnssec = "1";
        },

        dhcp: function (state) {
            if ($("#divDhcpEditScope").is(":visible")) {
                var scope = $("#txtDhcpScopeName").attr("data-name");
                if ((scope != null) && (scope !== ""))
                    state.scope = scope;
            }
        },

        logs: function (state) {
            if (state.t === "logs.view") {
                if ($("#divLogViewer").is(":visible"))
                    setIfMeaningful(state, "f", $("#txtLogViewerTitle").text());
            }
            else if (state.t === "logs.query") {
                if (!$("#divQueryLogsTable").is(":visible"))
                    return;

                setIfMeaningful(state, "app", $("#optQueryLogsAppName").val());
                setIfMeaningful(state, "cp", $("#optQueryLogsClassPath").val());
                setIfMeaningful(state, "p", $("#txtQueryLogPageNumber").val(), "1");
                setIfMeaningful(state, "desc", $("#optQueryLogsDescendingOrder").val(), "true");
                setIfMeaningful(state, "start", $("#txtQueryLogStart").val());
                setIfMeaningful(state, "end", $("#txtQueryLogEnd").val());
                setIfMeaningful(state, "client", $("#txtQueryLogClientIpAddress").val());
                setIfMeaningful(state, "proto", $("#optQueryLogsProtocol").val());
                setIfMeaningful(state, "rtype", $("#optQueryLogsResponseType").val());
                setIfMeaningful(state, "rcode", $("#optQueryLogsResponseCode").val());
                setIfMeaningful(state, "qname", $("#txtQueryLogQName").val());
                setIfMeaningful(state, "qtype", $("#txtQueryLogQType").val());
                setIfMeaningful(state, "qclass", $("#optQueryLogQClass").val());
            }
        }
    };

    function setIfMeaningful(state, key, value, defaultValue) {
        if ((value == null) || (value === ""))
            return;

        value = String(value);

        if ((defaultValue != null) && (value === defaultValue))
            return;

        state[key] = value;
    }

    //the cache/allowed/blocked viewers keep the browsed node only as the text
    //of their title element, using "<ROOT>" as the sentinel for the root
    function currentTreeDomain(titleSelector) {
        var domain = $(titleSelector).text();

        if ((domain == null) || (domain === "<ROOT>"))
            return null;

        return domain;
    }

    // --------------------------------------------------------------- applying

    function suppress(action) {
        suppressDepth++;

        try {
            action();
        }
        finally {
            suppressDepth--;
        }
    }

    //activates a tab without firing its inline onclick handler, so that the
    //restore logic below stays in full control of what gets loaded and in
    //what order
    function activateTab(elementId) {
        var li = $("#" + elementId);

        if ((li.length === 0) || !li.is(":visible"))
            return false;

        li.children("a").first().tab("show");
        return true;
    }

    function applyState(state) {
        if (state == null)
            return false;

        var route = splitRoute(state.t);
        var tab = findMainTab(route.tab);

        if ((tab == null) || !canView(route.tab))
            return false;

        var applied = false;

        suppress(function () {
            if (!activateTab("mainPanelTabList" + tab.id))
                return;

            var activeSub = route.sub;

            if (tab.group != null) {
                if (route.sub != null) {
                    var sub = findSubTab(tab.group, route.sub);
                    if (sub != null)
                        activateTab(tab.group + "TabList" + sub.id);
                }

                //a sub tab this user cannot see will not have activated, so
                //restore whatever is actually on screen rather than what the
                //URL asked for
                activeSub = activeSubTabKey(tab.group);
            }

            var restore = RESTORE[route.tab];
            if (restore != null)
                restore(state, activeSub);

            applied = true;
        });

        if (applied) {
            currentState = state;
            $(document).trigger("router:changed", [state]);
        }

        return applied;
    }

    //per tab reload of whatever the tab's own onclick handler would have done,
    //plus the extra state carried in the URL
    var RESTORE = {
        dashboard: function (state) {
            var range = state.range == null ? "lastHour" : state.range;
            var radio = $("input[name=rdStatType][value='" + range + "']");

            if (radio.length > 0) {
                radio.prop("checked", true);

                //the range picker is a bootstrap button group, so the visual
                //selection lives on the wrapping label, not on the radio
                radio.closest(".btn-group").children("label").removeClass("active");
                radio.closest("label").addClass("active");
            }

            if (range === "custom") {
                $("#divCustomDayWise").show();
                $("#dpCustomDayWiseStart").val(state.start == null ? "" : state.start);
                $("#dpCustomDayWiseEnd").val(state.end == null ? "" : state.end);
            }
            else {
                $("#divCustomDayWise").hide();
            }

            refreshDashboard();
        },

        zones: function (state) {
            if ((state.zone != null) && (state.zone !== "")) {
                //goes straight to the zone; refreshZones() is deliberately not
                //called here because its response would race with this one and
                //flip the view back to the zone list
                showEditZone(state.zone, state.p == null ? 1 : Number(state.p), state.fn == null ? "" : state.fn, state.ft == null ? "" : state.ft);
                return;
            }

            $("#txtZonesFilterName").val(state.fn == null ? "" : state.fn);
            $("#optZonesFilterType").val(state.ft == null ? "" : state.ft);
            $("#divEditZone").hide();
            $("#divViewZones").show();

            refreshZones(false, state.p == null ? 1 : Number(state.p));
        },

        cache: function (state) {
            refreshCachedZonesList(state.d == null ? "" : state.d);
        },

        allowed: function (state) {
            refreshAllowedZonesList(state.d == null ? "" : state.d);
        },

        blocked: function (state) {
            refreshBlockedZonesList(state.d == null ? "" : state.d);
        },

        apps: function () {
            refreshApps();
        },

        dnsclient: function (state) {
            if (state.s != null)
                $("#txtDnsClientNameServer").val(state.s);

            $("#txtDnsClientDomain").val(state.d == null ? "" : state.d);
            $("#optDnsClientType").val(state.type == null ? "A" : state.type);
            $("#optDnsClientProtocol").val(state.proto == null ? "UDP" : state.proto);
            $("#txtDnsClientEDnsClientSubnet").val(state.ecs == null ? "" : state.ecs);
            $("#chkDnsClientDnssecValidation").prop("checked", state.dnssec === "1");

            if ((state.d != null) && (state.d !== ""))
                resolveQuery();
        },

        settings: function () {
            refreshDnsSettings();
        },

        dhcp: function (state, sub) {
            if (sub === "scopes") {
                if ((state.scope != null) && (state.scope !== "")) {
                    //same race as the zone editor: loading the scope list here
                    //would hide the scope being restored
                    showEditDhcpScope(state.scope);
                    return;
                }

                $("#divDhcpEditScope").hide();
                $("#divDhcpViewScopes").show();
                refreshDhcpScopes(false);
                return;
            }

            refreshDhcpLeases();
        },

        admin: function (state, sub) {
            switch (sub) {
                case "users":
                    refreshAdminUsers();
                    break;

                case "groups":
                    refreshAdminGroups();
                    break;

                case "permissions":
                    refreshAdminPermissions();
                    break;

                case "sso":
                    refreshAdminSsoConfig();
                    break;

                case "cluster":
                    refreshAdminCluster();
                    break;

                default:
                    refreshAdminSessions();
                    break;
            }
        },

        logs: function (state, sub) {
            if (sub === "query") {
                applyQueryLogsFilters(state);
                refreshQueryLogsTab((state.app != null) || (state.qname != null) || (state.client != null) || (state.p != null));
                return;
            }

            //refreshLogFilesList opens the named file once the list has loaded
            if ((state.f != null) && (state.f !== ""))
                refreshLogFilesList(state.f);
            else
                refreshLogFilesList();
        },

        about: function () {
        }
    };

    function applyQueryLogsFilters(state) {
        if (state.app != null)
            $("#optQueryLogsAppName").val(state.app);

        if (state.cp != null)
            $("#optQueryLogsClassPath").val(state.cp);

        $("#txtQueryLogPageNumber").val(state.p == null ? 1 : state.p);

        if (state.desc != null)
            $("#optQueryLogsDescendingOrder").val(state.desc);

        $("#txtQueryLogStart").val(state.start == null ? "" : state.start);
        $("#txtQueryLogEnd").val(state.end == null ? "" : state.end);
        $("#txtQueryLogClientIpAddress").val(state.client == null ? "" : state.client);

        if (state.proto != null)
            $("#optQueryLogsProtocol").val(state.proto);

        if (state.rtype != null)
            $("#optQueryLogsResponseType").val(state.rtype);

        if (state.rcode != null)
            $("#optQueryLogsResponseCode").val(state.rcode);

        $("#txtQueryLogQName").val(state.qname == null ? "" : state.qname);
        $("#txtQueryLogQType").val(state.qtype == null ? "" : state.qtype);

        if (state.qclass != null)
            $("#optQueryLogQClass").val(state.qclass);
    }

    // ------------------------------------------------------------------ hooks

    //wraps a global function so that the URL is updated whenever it is called,
    //leaving the original implementation untouched
    function wrap(name, onCall) {
        var original = window[name];

        if (typeof original !== "function")
            return;

        window[name] = function () {
            var result = original.apply(this, arguments);

            if (started && (suppressDepth === 0)) {
                try {
                    onCall.apply(this, arguments);
                }
                catch (e) {
                    //never let routing break a working view
                    if ((window.console != null) && (window.console.warn != null))
                        window.console.warn("Router: failed to record navigation for " + name, e);
                }
            }

            return result;
        };
    }

    function installFunctionHooks() {
        //when the session ends, stop recording but remember where the user was
        //so that logging back in returns them to it
        var originalShowPageLogin = window.showPageLogin;

        if (typeof originalShowPageLogin === "function") {
            window.showPageLogin = function () {
                if (started) {
                    pendingState = currentState == null ? parseUrl() : currentState;
                    started = false;
                    currentState = null;
                }

                return originalShowPageLogin.apply(this, arguments);
            };
        }

        wrap("showEditZone", function (zone, pageNumber, filterName, filterType) {
            if ((zone == null) || (zone === ""))
                return; //showEditZonePage records the zone once the response lands

            var state = { t: "zones", zone: zone };

            setIfMeaningful(state, "p", pageNumber, "1");
            setIfMeaningful(state, "fn", filterName);
            setIfMeaningful(state, "ft", filterType);

            record(state);
        });

        //fired from inside showEditZone once the records are in, and on every
        //page/filter change within a zone: refines the entry rather than
        //adding one
        wrap("showEditZonePage", function () {
            if (!$("#mainPanelTabListZones").hasClass("active"))
                return;

            recordCurrent(true);
        });

        wrap("refreshZones", function (checkDisplay, pageNumber) {
            if (!$("#mainPanelTabListZones").hasClass("active"))
                return;

            var state = { t: "zones" };

            setIfMeaningful(state, "p", pageNumber == null ? $("#txtZonesPageNumber").val() : pageNumber, "1");
            setIfMeaningful(state, "fn", $("#txtZonesFilterName").val());
            setIfMeaningful(state, "ft", $("#optZonesFilterType").val());

            record(state);
        });

        wrap("resolveQuery", function () {
            if (!$("#mainPanelTabListDnsClient").hasClass("active"))
                return;

            recordCurrent();
        });

        wrap("viewLog", function (logFile) {
            if (!$("#logsTabListLogViewer").hasClass("active"))
                return;

            record({ t: "logs.view", f: logFile });
        });

        wrap("queryLogs", function (pageNumber, liveUpdate) {
            if (liveUpdate || !$("#logsTabListQueryLogs").hasClass("active"))
                return;

            //the table is only shown once the response lands, so capture the
            //form directly instead of going through CAPTURE.logs
            var state = { t: "logs.query" };

            setIfMeaningful(state, "app", $("#optQueryLogsAppName").val());
            setIfMeaningful(state, "cp", $("#optQueryLogsClassPath").val());
            setIfMeaningful(state, "p", pageNumber == null ? $("#txtQueryLogPageNumber").val() : pageNumber, "1");
            setIfMeaningful(state, "desc", $("#optQueryLogsDescendingOrder").val(), "true");
            setIfMeaningful(state, "start", $("#txtQueryLogStart").val());
            setIfMeaningful(state, "end", $("#txtQueryLogEnd").val());
            setIfMeaningful(state, "client", $("#txtQueryLogClientIpAddress").val());
            setIfMeaningful(state, "proto", $("#optQueryLogsProtocol").val());
            setIfMeaningful(state, "rtype", $("#optQueryLogsResponseType").val());
            setIfMeaningful(state, "rcode", $("#optQueryLogsResponseCode").val());
            setIfMeaningful(state, "qname", $("#txtQueryLogQName").val());
            setIfMeaningful(state, "qtype", $("#txtQueryLogQType").val());
            setIfMeaningful(state, "qclass", $("#optQueryLogQClass").val());

            record(state, true);
        });

        wrap("showEditDhcpScope", function (scopeName) {
            record({ t: "dhcp.scopes", scope: scopeName });
        });

        wrap("refreshDhcpScopes", function () {
            if (!$("#dhcpTabListScopes").hasClass("active"))
                return;

            record({ t: "dhcp.scopes" });
        });
    }

    //the dashboard range picker and its custom date range are plain form
    //controls with no function of their own to wrap
    function installDashboardHooks() {
        $(document).on("change", "input[name=rdStatType]", function () {
            if ($("#mainPanelTabListDashboard").hasClass("active"))
                recordCurrent();
        });

        $(document).on("click", "#btnCustomDayWise", function () {
            if ($("#mainPanelTabListDashboard").hasClass("active"))
                recordCurrent(true);
        });
    }

    function installTabHooks() {
        $(document).on("shown.bs.tab", 'a[data-toggle="tab"]', function () {
            if (!started || (suppressDepth > 0))
                return;

            var elementId = $(this).parent("li").attr("id");
            if (elementId == null)
                return;

            //ignore tab strips that live inside modals
            if ((findMainTabByElementId(elementId) == null) && (findSubTabByElementId(elementId) == null))
                return;

            recordCurrent();
        });
    }

    //the cache/allowed/blocked browsers have no callback to hook, so watch the
    //element that holds the node they are showing
    function installTreeObservers() {
        if (typeof MutationObserver === "undefined")
            return;

        var trees = [
            { key: "cache", titleId: "txtCachedZoneViewerTitle", listId: "mainPanelTabListCachedZones" },
            { key: "allowed", titleId: "txtAllowedZoneViewerTitle", listId: "mainPanelTabListAllowedZones" },
            { key: "blocked", titleId: "txtBlockedZoneViewerTitle", listId: "mainPanelTabListBlockedZones" }
        ];

        for (var i = 0; i < trees.length; i++) {
            (function (tree) {
                var element = document.getElementById(tree.titleId);
                if (element == null)
                    return;

                new MutationObserver(function () {
                    if (!started || (suppressDepth > 0))
                        return;

                    if (!$("#" + tree.listId).hasClass("active"))
                        return;

                    recordCurrent();
                }).observe(element, { childList: true, characterData: true, subtree: true });
            })(trees[i]);
        }
    }

    function installHistoryHook() {
        window.addEventListener("popstate", function () {
            if (!started)
                return;

            var state = parseUrl();

            if (state == null) {
                //back to the bare URL: fall back to the landing tab
                state = { t: canView("dashboard") ? "dashboard" : (activeMainTabKey() || "about") };
            }

            if (!applyState(state)) {
                //the URL points at something this user cannot see any more
                currentState = null;
                recordCurrent(true);
            }
        });
    }

    // ----------------------------------------------------------------- public

    //captured while this file is being evaluated, i.e. before any $(document).ready
    //handler gets a chance to rewrite the address bar
    var pendingState = parseUrl();

    return {
        //called once, on document ready, before the session is known
        init: function () {
            installFunctionHooks();
            installDashboardHooks();
            installTabHooks();
            installTreeObservers();
            installHistoryHook();
        },

        //called at the end of showPageMain(), once the main page and its
        //permission driven tab visibility are in place
        start: function () {
            started = true;

            var state = pendingState;
            pendingState = null;

            if ((state != null) && applyState(state)) {
                window.history.replaceState(state, "", buildUrl(state));
                return;
            }

            //no usable URL state: record whatever showPageMain landed on
            currentState = null;
            recordCurrent(true);
        },

        //called when the session ends so a stale view is not recorded
        stop: function () {
            started = false;
            currentState = null;
        },

        //navigates to a state as if the user had clicked their way there
        go: function (state) {
            if (applyState(state))
                window.history.pushState(state, "", buildUrl(state));
        },

        //current state, for the "copy link to this view" button
        current: function () {
            return currentState == null ? captureCurrent() : currentState;
        },

        url: function (state) {
            return window.location.protocol + "//" + window.location.host + buildUrl(state == null ? this.current() : state);
        },

        //lets other modules (global search) record their own view
        record: function (state, forceReplace) {
            record(state, forceReplace);
        },

        isStarted: function () {
            return started;
        },

        //lets showPageMain() skip a default load that would otherwise race
        //with the view the URL asks for
        hasPendingRoute: function () {
            return pendingState != null;
        }
    };
})();

$(function () {
    Router.init();
});
