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
// FORK ADDITION - not present upstream.
//
// Cross zone record search, backing the console's global search box. Kept in
// its own partial class file so that the only change to the upstream
// WebServiceZonesApi.cs is the "partial" keyword on the class declaration.
//
// Depends on upstream members: _dnsWebService, WriteRecordAsJson(),
// WriteZoneInfoAsJson(). Route is registered in DnsWebService.cs.
//

using DnsServerCore.Auth;
using DnsServerCore.Dns.ResourceRecords;
using DnsServerCore.Dns.Zones;
using Microsoft.AspNetCore.Http;
using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.RegularExpressions;
using TechnitiumLibrary.Net.Dns;
using TechnitiumLibrary.Net.Dns.ResourceRecords;

namespace DnsServerCore
{
    public partial class DnsWebService
    {
        partial class WebServiceZonesApi
        {
            #region fork: cross zone record search

            public void SearchRecords(HttpContext context)
            {
                User sessionUser = _dnsWebService.GetSessionUser(context);

                if (!_dnsWebService._authManager.IsPermitted(PermissionSection.Zones, sessionUser, PermissionFlag.View))
                    throw new DnsWebServiceException("Access was denied.");

                HttpRequest request = context.Request;

                string query = request.GetQueryOrForm("q").Trim();
                if (query.Length == 0)
                    throw new DnsWebServiceException("Parameter 'q' must not be empty.");

                //name: match the record owner name and its zone; value: match the record data; all: both
                string scope = request.GetQueryOrForm("scope", "all").Trim().ToLowerInvariant();

                switch (scope)
                {
                    case "name":
                    case "value":
                    case "all":
                        break;

                    default:
                        throw new DnsWebServiceException("Parameter 'scope' must be 'name', 'value' or 'all'.");
                }

                bool matchName = (scope == "name") || (scope == "all");
                bool matchValue = (scope == "value") || (scope == "all");

                DnsResourceRecordType filterType = request.GetQueryOrFormEnum("type", DnsResourceRecordType.Unknown);
                string filterZone = request.GetQueryOrForm("zone", null);
                bool filterZoneExact = request.GetQueryOrForm("zoneExact", bool.Parse, false);

                int maxResults = request.GetQueryOrForm("maxResults", int.Parse, 100);
                if (maxResults < 1)
                    maxResults = 1;
                else if (maxResults > 1000)
                    maxResults = 1000;

                Regex queryRegex = CreateWildcardRegex(query);

                //Constraining a search to one specific zone is not expressible in the
                //wildcard syntax: a pattern with no wildcard is deliberately left
                //unanchored, so "example.com" also matches "myexample.com" and every
                //sub zone of it. The console's "search within this zone" needs exactly
                //one zone, so it asks for an equality test instead.
                string exactZone = null;
                Regex zoneRegex = null;

                if (!string.IsNullOrEmpty(filterZone))
                {
                    if (filterZoneExact)
                        exactZone = (filterZone == ".") ? "" : filterZone.TrimEnd('.'); //"." is how the root zone is written in a URL
                    else
                        zoneRegex = CreateWildcardRegex(filterZone);
                }

                //DNSSEC bookkeeping records swamp the results and are never what a
                //user is looking for, unless they explicitly asked for that type
                bool skipDnssecRecords;

                switch (filterType)
                {
                    case DnsResourceRecordType.RRSIG:
                    case DnsResourceRecordType.NSEC:
                    case DnsResourceRecordType.NSEC3:
                    case DnsResourceRecordType.NSEC3PARAM:
                    case DnsResourceRecordType.DNSKEY:
                        skipDnssecRecords = false;
                        break;

                    default:
                        skipDnssecRecords = true;
                        break;
                }

                IReadOnlyList<AuthZoneInfo> zoneInfoList = _dnsWebService._dnsServer.AuthZoneManager.GetZones(delegate (AuthZoneInfo zoneInfo)
                {
                    if (!_dnsWebService._authManager.IsPermitted(PermissionSection.Zones, zoneInfo.Name, sessionUser, PermissionFlag.View))
                        return false;

                    if (exactZone is not null)
                        return zoneInfo.Name.Equals(exactZone, StringComparison.OrdinalIgnoreCase);

                    if ((zoneRegex is not null) && !zoneRegex.IsMatch(zoneInfo.Name))
                        return false;

                    return true;
                });

                //zones whose own name matches are reported separately: expanding them
                //into every record they hold would bury the actual record hits
                List<AuthZoneInfo> matchedZones = new List<AuthZoneInfo>();
                List<KeyValuePair<AuthZoneInfo, DnsResourceRecord>> results = new List<KeyValuePair<AuthZoneInfo, DnsResourceRecord>>();
                List<DnsResourceRecord> records = new List<DnsResourceRecord>();
                bool truncated = false;
                int zonesSearched = 0;

                try
                {
                    if (matchName)
                    {
                        foreach (AuthZoneInfo zoneInfo in zoneInfoList)
                        {
                            if (queryRegex.IsMatch(zoneInfo.Name) || (DnsClient.TryConvertDomainNameToUnicode(zoneInfo.Name, out string zoneNameIdn) && queryRegex.IsMatch(zoneNameIdn)))
                            {
                                matchedZones.Add(zoneInfo);

                                if (matchedZones.Count >= maxResults)
                                {
                                    truncated = true;
                                    break;
                                }
                            }
                        }
                    }

                    foreach (AuthZoneInfo zoneInfo in zoneInfoList)
                    {
                        if (results.Count >= maxResults)
                        {
                            truncated = true;
                            break;
                        }

                        records.Clear();
                        _dnsWebService._dnsServer.AuthZoneManager.ListAllZoneRecords(zoneInfo.Name, records);
                        zonesSearched++;

                        foreach (DnsResourceRecord record in records)
                        {
                            if ((filterType != DnsResourceRecordType.Unknown) && (record.Type != filterType))
                                continue;

                            if (skipDnssecRecords)
                            {
                                switch (record.Type)
                                {
                                    case DnsResourceRecordType.RRSIG:
                                    case DnsResourceRecordType.NSEC:
                                    case DnsResourceRecordType.NSEC3:
                                    case DnsResourceRecordType.NSEC3PARAM:
                                    case DnsResourceRecordType.DNSKEY:
                                        continue;
                                }
                            }

                            if (!RecordMatches(record, queryRegex, matchName, matchValue))
                                continue;

                            if (results.Count >= maxResults)
                            {
                                truncated = true;
                                break;
                            }

                            results.Add(new KeyValuePair<AuthZoneInfo, DnsResourceRecord>(zoneInfo, record));
                        }
                    }
                }
                catch (RegexMatchTimeoutException)
                {
                    throw new DnsWebServiceException("The search expression took too long to evaluate. Use a simpler search term or fewer wildcards.");
                }

                Utf8JsonWriter jsonWriter = context.GetCurrentJsonWriter();

                jsonWriter.WriteBoolean("truncated", truncated);
                jsonWriter.WriteNumber("zonesSearched", zonesSearched);
                jsonWriter.WriteNumber("totalZones", zoneInfoList.Count);

                jsonWriter.WritePropertyName("zones");
                jsonWriter.WriteStartArray();

                foreach (AuthZoneInfo zoneInfo in matchedZones)
                    WriteZoneInfoAsJson(zoneInfo, jsonWriter);

                jsonWriter.WriteEndArray();

                jsonWriter.WritePropertyName("results");
                jsonWriter.WriteStartArray();

                foreach (KeyValuePair<AuthZoneInfo, DnsResourceRecord> result in results)
                {
                    jsonWriter.WriteStartObject();

                    jsonWriter.WriteString("zone", result.Key.Name);

                    if (DnsClient.TryConvertDomainNameToUnicode(result.Key.Name, out string zoneIdn))
                        jsonWriter.WriteString("zoneIdn", zoneIdn);

                    jsonWriter.WriteString("zoneType", result.Key.Type.ToString());

                    jsonWriter.WritePropertyName("record");
                    WriteRecordAsJson(result.Value, jsonWriter, true, result.Key);

                    jsonWriter.WriteEndObject();
                }

                jsonWriter.WriteEndArray();
            }

            //same wildcard syntax as the zone list filter: abc, a*, *b*, a?c.
            //A pattern with no wildcard is left unanchored, so it matches anywhere.
            private static Regex CreateWildcardRegex(string filter)
            {
                filter = filter.Trim();

                string pattern = filter.Replace("\\", "\\\\").Replace(".", "\\.").Replace("+", "\\+").Replace("(", "\\(").Replace(")", "\\)").Replace("[", "\\[").Replace("]", "\\]").Replace("{", "\\{").Replace("}", "\\}").Replace("^", "\\^").Replace("$", "\\$").Replace("|", "\\|").Replace("*", ".*").Replace("?", ".{1}");

                if (filter.Contains('*'))
                {
                    if (!filter.StartsWith('*'))
                        pattern = "^" + pattern;

                    if (!filter.EndsWith('*'))
                        pattern += "$";
                }

                //not compiled: this regex is built per request and compiled regexes are never reclaimed
                return new Regex(pattern, RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(5));
            }

            private static bool RecordMatches(DnsResourceRecord record, Regex queryRegex, bool matchName, bool matchValue)
            {
                if (matchName)
                {
                    if (queryRegex.IsMatch(record.Name))
                        return true;

                    if (DnsClient.TryConvertDomainNameToUnicode(record.Name, out string nameIdn) && queryRegex.IsMatch(nameIdn))
                        return true;
                }

                if (matchValue)
                {
                    string rData = record.RDATA?.ToString();

                    if ((rData is not null) && queryRegex.IsMatch(rData))
                        return true;

                    string comments = record.GetAuthGenericRecordInfo()?.Comments;

                    if (!string.IsNullOrEmpty(comments) && queryRegex.IsMatch(comments))
                        return true;
                }

                return false;
            }

            #endregion
        }
    }
}
