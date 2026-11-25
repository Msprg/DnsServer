#!/usr/bin/env python3
"""Two-node zone transfer regression test for the fork's zone transfer fixes
(see "Root zone A/AAAA records never reach secondaries" and "A zone transfer
fails when the secondary hosts a zone below it" in FORK.md).

Usage: python3 tools/test-root-zone-sync.py <docker image> [--keep]

Starts a primary and a secondary container from the image on a private docker
network, builds zones on the primary through the HTTP API, and checks with
`dig` what the secondary serves after AXFR, IXFR and Resync. Covers a custom
root Primary zone, a "." Forwarder zone delivered through a Catalog zone (the
production shape), a normal zone as a control, and a secondary that hosts its
own zone below the zone it transfers (the fork's skip of such names). Prints one PASS/FAIL line
per check and exits 1 if any fail. Needs docker and dig on the host, and a host
that can reach container IPs on the bridge network. --keep leaves the
containers running for inspection.
"""
import json, subprocess, sys, time, urllib.parse, urllib.request

IMAGE = sys.argv[1]
NET = "rootsync-test"
P, S = "rootsync-test-primary", "rootsync-test-secondary"
results = []


def sh(*a, check=True):
    return subprocess.run(a, capture_output=True, text=True, check=check).stdout.strip()


def ip(c):
    return sh("docker", "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", c)


class Node:
    def __init__(self, name):
        self.name, self.ip = name, ip(name)
        for _ in range(60):
            try:
                self.token = self.raw("/api/user/login", user="admin", **{"pass": "admin"})["token"]
                return
            except Exception:
                time.sleep(1)
        raise RuntimeError("login failed on " + name)

    def raw(self, path, **params):
        url = "http://%s:5380%s?%s" % (self.ip, path, urllib.parse.urlencode(params))
        r = json.load(urllib.request.urlopen(url, timeout=30))
        if r.get("status") != "ok":
            raise RuntimeError("%s %s: %s" % (path, params, r.get("errorMessage")))
        return r

    def api(self, path, **params):
        return self.raw(path, token=self.token, **params).get("response")


def dig(node, name, qtype, *opts):
    out = sh("dig", "+norec", "+time=2", "+tries=1", "@" + node.ip, name, qtype, *opts, check=False)
    return out


def answer(node, name, qtype):
    return sh("dig", "+norec", "+short", "+time=2", "+tries=1", "@" + node.ip, name, qtype, check=False)


def check(label, ok, detail=""):
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + label + (("  [" + detail + "]") if detail and not ok else ""))


def wait_for(fn, timeout=25):
    end = time.time() + timeout
    while time.time() < end:
        if fn():
            return True
        time.sleep(1)
    return fn()


def start():
    sh("docker", "network", "create", NET, check=False)
    for c in (P, S):
        sh("docker", "rm", "-f", c, check=False)
        sh("docker", "run", "-d", "--name", c, "--network", NET,
           "-e", "DNS_SERVER_ADMIN_PASSWORD=admin", "-e", "DNS_SERVER_RECURSION=Deny", IMAGE)


def main():
    start()
    p, s = Node(P), Node(S)
    for n in (p, s):
        n.api("/api/settings/set", loggingType="File")

    # ---------- 1. custom root Primary zone -> Secondary "."
    p.api("/api/zones/create", zone=".", type="Primary")
    p.api("/api/zones/options/set", zone=".", zoneTransfer="Allow", notify="SpecifiedNameServers", notifyNameServers=s.ip)
    add = lambda z, **kw: p.api("/api/zones/records/add", zone=z, **kw)
    add(".", domain="host1.test", type="A", ipAddress="10.0.0.1")
    add(".", domain="host1.test", type="AAAA", ipAddress="fd00::1")
    add(".", domain="txt1.test", type="TXT", text="hello")
    add(".", domain="alias.test", type="CNAME", cname="host1.test")
    # delegation with in-bailiwick glue (must stay glue)
    add(".", domain="deleg", type="NS", nameServer="ns1.deleg", glue="10.9.9.9")
    # delegation whose NS target is an in-zone name outside any delegation
    add(".", domain="deleg2", type="NS", nameServer="nsout.test")
    add(".", domain="nsout.test", type="A", ipAddress="10.8.8.8")

    s.api("/api/zones/create", zone=".", type="Secondary", primaryNameServerAddresses=p.ip)
    wait_for(lambda: answer(s, "txt1.test", "TXT") != "")

    check("root AXFR: TXT record synced", answer(s, "txt1.test", "TXT") == '"hello"', answer(s, "txt1.test", "TXT"))
    check("root AXFR: CNAME record synced", "host1.test." in answer(s, "alias.test", "CNAME"))
    check("root AXFR: A record synced", answer(s, "host1.test", "A") == "10.0.0.1", answer(s, "host1.test", "A"))
    check("root AXFR: AAAA record synced", answer(s, "host1.test", "AAAA") == "fd00::1", answer(s, "host1.test", "AAAA"))
    check("root AXFR: A record of NS target outside delegation synced", answer(s, "nsout.test", "A") == "10.8.8.8", answer(s, "nsout.test", "A"))
    ref = dig(s, "www.deleg", "A")
    check("root AXFR: referral to deleg keeps glue 10.9.9.9", "ns1.deleg.\t" in ref and "10.9.9.9" in ref, ref[-400:])
    check("root AXFR: glue not answered as authoritative data", "status: NOERROR" not in dig(s, "ns1.deleg", "A") or "flags: qr aa" not in dig(s, "ns1.deleg", "A"))

    # ---------- 2. IXFR changes on the root zone
    add(".", domain="host2.test", type="A", ipAddress="10.0.0.2")
    p.api("/api/zones/records/delete", zone=".", domain="host1.test", type="AAAA", ipAddress="fd00::1")
    add(".", domain="deleg3", type="NS", nameServer="ns1.deleg3", glue="10.7.7.7")
    add(".", domain="txt2.test", type="TXT", text="second")
    wait_for(lambda: answer(s, "txt2.test", "TXT") != "")
    check("root IXFR: TXT add synced", answer(s, "txt2.test", "TXT") == '"second"')
    check("root IXFR: A add synced", answer(s, "host2.test", "A") == "10.0.0.2", answer(s, "host2.test", "A"))
    check("root IXFR: AAAA delete synced", answer(s, "host1.test", "AAAA") == "", answer(s, "host1.test", "AAAA"))
    ref = dig(s, "www.deleg3", "A")
    check("root IXFR: new delegation carries glue 10.7.7.7", "10.7.7.7" in ref, ref[-400:])

    # glue added later to an existing delegation, through IXFR
    p.api("/api/zones/records/update", zone=".", domain="deleg", type="NS", nameServer="ns1.deleg", newNameServer="ns1.deleg", glue="10.9.9.9,10.9.9.10")
    add(".", domain="txt3.test", type="TXT", text="third")
    wait_for(lambda: answer(s, "txt3.test", "TXT") != "")
    ref = dig(s, "www.deleg", "A")
    check("root IXFR: glue added to existing delegation", "10.9.9.10" in ref, ref[-400:])

    p.api("/api/zones/records/delete", zone=".", domain="host2.test", type="A", ipAddress="10.0.0.2")
    add(".", domain="txt4.test", type="TXT", text="fourth")
    wait_for(lambda: answer(s, "txt4.test", "TXT") != "")
    check("root IXFR: A delete synced", answer(s, "host2.test", "A") == "", answer(s, "host2.test", "A"))

    # glue-only IXFR: the delegation is already on the secondary and the address
    # record for its NS target arrives alone, so only the zone tree can tell it is glue
    add(".", domain="deleg5", type="NS", nameServer="ns1.deleg5")
    add(".", domain="txt5.test", type="TXT", text="fifth")
    wait_for(lambda: answer(s, "txt5.test", "TXT") != "")
    add(".", domain="ns1.deleg5", type="A", ipAddress="10.5.5.5")
    add(".", domain="txt6.test", type="TXT", text="sixth")
    wait_for(lambda: answer(s, "txt6.test", "TXT") != "")
    ref = dig(s, "www.deleg5", "A")
    check("root IXFR: A below an existing delegation lands as glue", "10.5.5.5" in ref, ref[-400:])
    recs = s.api("/api/zones/records/get", zone=".", domain="ns1.deleg5")["records"]
    check("root IXFR: ...and is not stored as an ordinary record", not any(r["type"] == "A" for r in recs), str(recs)[:300])

    # forced resync (AXFR over an already populated zone)
    s.api("/api/zones/resync", zone=".")
    time.sleep(4)
    check("root resync: A record still there", answer(s, "host1.test", "A") == "10.0.0.1", answer(s, "host1.test", "A"))
    ref = dig(s, "www.deleg", "A")
    check("root resync: glue still there", "10.9.9.10" in ref and "10.9.9.9" in ref, ref[-400:])

    # ---------- 3. normal zone regression
    p.api("/api/zones/create", zone="example.com", type="Primary")
    p.api("/api/zones/options/set", zone="example.com", zoneTransfer="Allow", notify="SpecifiedNameServers", notifyNameServers=s.ip)
    add("example.com", domain="www.example.com", type="A", ipAddress="192.0.2.1")
    add("example.com", domain="www.example.com", type="AAAA", ipAddress="2001:db8::1")
    add("example.com", domain="sub.example.com", type="NS", nameServer="ns1.sub.example.com", glue="192.0.2.53")
    add("example.com", domain="ext.example.com", type="NS", nameServer="ns.other.net", glue="198.51.100.53")
    s.api("/api/zones/create", zone="example.com", type="Secondary", primaryNameServerAddresses=p.ip)
    wait_for(lambda: answer(s, "www.example.com", "A") != "")
    check("normal AXFR: A synced", answer(s, "www.example.com", "A") == "192.0.2.1")
    check("normal AXFR: AAAA synced", answer(s, "www.example.com", "AAAA") == "2001:db8::1")
    ref = dig(s, "x.sub.example.com", "A")
    check("normal AXFR: in-zone glue in referral", "192.0.2.53" in ref, ref[-400:])
    ref = dig(s, "x.ext.example.com", "A")
    check("normal AXFR: out-of-zone glue in referral", "198.51.100.53" in ref, ref[-400:])
    add("example.com", domain="new.example.com", type="A", ipAddress="192.0.2.2")
    wait_for(lambda: answer(s, "new.example.com", "A") != "")
    check("normal IXFR: A add synced", answer(s, "new.example.com", "A") == "192.0.2.2")

    # ---------- 4. production shape: "." Forwarder in a catalog -> Secondary Forwarder via Secondary Catalog
    p.api("/api/zones/delete", zone=".")
    s.api("/api/zones/delete", zone=".")
    p.api("/api/zones/create", zone="catalog.test", type="Catalog")
    p.api("/api/zones/options/set", zone="catalog.test", zoneTransfer="Allow", notify="SpecifiedNameServers", notifyNameServers=s.ip)
    p.api("/api/zones/create", zone=".", type="Forwarder", forwarder="this-server", catalog="catalog.test")
    p.api("/api/zones/records/add", zone=".", domain="ostapi.test", type="A", ipAddress="100.66.20.7")
    p.api("/api/zones/records/add", zone=".", domain="ostapi.test", type="TXT", text="fwd")
    s.api("/api/zones/create", zone="catalog.test", type="SecondaryCatalog", primaryNameServerAddresses=p.ip)
    wait_for(lambda: answer(s, "ostapi.test", "TXT") != "", 40)
    zones = {z["name"]: z["type"] for z in s.api("/api/zones/list")["zones"]}
    check("catalog: secondary got '.' as SecondaryForwarder", zones.get("") == "SecondaryForwarder", str(zones))
    check("forwarder AXFR: TXT synced", answer(s, "ostapi.test", "TXT") == '"fwd"', answer(s, "ostapi.test", "TXT"))
    check("forwarder AXFR: A synced", answer(s, "ostapi.test", "A") == "100.66.20.7", answer(s, "ostapi.test", "A"))
    p.api("/api/zones/records/add", zone=".", domain="ostapi2.test", type="A", ipAddress="100.66.20.8")
    p.api("/api/zones/records/add", zone=".", domain="ostapi2.test", type="TXT", text="fwd2")
    wait_for(lambda: answer(s, "ostapi2.test", "TXT") != "", 40)
    check("forwarder IXFR: A add synced", answer(s, "ostapi2.test", "A") == "100.66.20.8", answer(s, "ostapi2.test", "A"))

    # ---------- 5. secondary hosts its own zone below "." (a local reverse zone, as on a cluster node)
    s.api("/api/zones/create", zone="70.23.172.in-addr.arpa", type="Primary")
    s.api("/api/zones/records/add", zone="70.23.172.in-addr.arpa", domain="5.70.23.172.in-addr.arpa", type="PTR", ptrName="local.test")
    p.api("/api/zones/records/add", zone=".", domain="5.70.23.172.in-addr.arpa", type="PTR", ptrName="primary.test")
    p.api("/api/zones/records/add", zone=".", domain="child1.test", type="TXT", text="child1")
    wait_for(lambda: answer(s, "child1.test", "TXT") != "", 40)
    check("local child zone: IXFR with a name under it syncs the rest", answer(s, "child1.test", "TXT") == '"child1"', answer(s, "child1.test", "TXT"))
    check("local child zone: its own record still answers", answer(s, "5.70.23.172.in-addr.arpa", "PTR") == "local.test.", answer(s, "5.70.23.172.in-addr.arpa", "PTR"))
    s.api("/api/zones/resync", zone=".")
    time.sleep(6)
    check("local child zone: Resync keeps '.' records", answer(s, "ostapi.test", "A") == "100.66.20.7" and answer(s, "child1.test", "TXT") == '"child1"',
          answer(s, "ostapi.test", "A") + " " + answer(s, "child1.test", "TXT"))
    check("local child zone: local record still answers after Resync", answer(s, "5.70.23.172.in-addr.arpa", "PTR") == "local.test.")
    log = sh("docker", "exec", S, "sh", "-c", "cat /var/log/technitium/dns/*.log", check=False)
    check("local child zone: no failed '.' refresh in the log", "failed to refresh '<root>'" not in log)
    check("local child zone: skipped name is logged", "skipped the name '5.70.23.172.in-addr.arpa'" in log)
    p.api("/api/zones/records/delete", zone=".", domain="5.70.23.172.in-addr.arpa", type="PTR", ptrName="primary.test")
    p.api("/api/zones/records/add", zone=".", domain="child2.test", type="TXT", text="child2")
    wait_for(lambda: answer(s, "child2.test", "TXT") != "", 40)
    check("local child zone: IXFR deleting a name under it syncs the rest", answer(s, "child2.test", "TXT") == '"child2"', answer(s, "child2.test", "TXT"))
    check("local child zone: local record survives the delete", answer(s, "5.70.23.172.in-addr.arpa", "PTR") == "local.test.")
    time.sleep(6)  # let the zone files save
    sh("docker", "restart", S)
    s = Node(S)
    wait_for(lambda: answer(s, "ostapi.test", "A") != "", 30)
    check("local child zone: zones load after restart", answer(s, "ostapi.test", "A") == "100.66.20.7" and answer(s, "child2.test", "TXT") == '"child2"'
          and answer(s, "5.70.23.172.in-addr.arpa", "PTR") == "local.test.", answer(s, "ostapi.test", "A") + " " + answer(s, "5.70.23.172.in-addr.arpa", "PTR"))
    log = sh("docker", "exec", S, "sh", "-c", "cat /var/log/technitium/dns/*.log", check=False)
    check("local child zone: no failed '.' refresh in the log after restart", "failed to refresh '<root>'" not in log and "does not belong" not in log)

    # ---------- 6. normal zone with a delegation to a zone the secondary hosts itself
    s.api("/api/zones/create", zone="child.example.net", type="Primary")
    s.api("/api/zones/records/add", zone="child.example.net", domain="www.child.example.net", type="A", ipAddress="192.0.2.80")
    p.api("/api/zones/create", zone="example.net", type="Primary")
    p.api("/api/zones/options/set", zone="example.net", zoneTransfer="Allow", notify="SpecifiedNameServers", notifyNameServers=s.ip)
    add("example.net", domain="www.example.net", type="A", ipAddress="192.0.2.70")
    add("example.net", domain="child.example.net", type="NS", nameServer="ns1.child.example.net", glue="192.0.2.81")
    add("example.net", domain="deep.child.example.net", type="A", ipAddress="192.0.2.82")
    s.api("/api/zones/create", zone="example.net", type="Secondary", primaryNameServerAddresses=p.ip)
    wait_for(lambda: answer(s, "www.example.net", "A") != "")
    check("local child zone, normal AXFR: parent records synced", answer(s, "www.example.net", "A") == "192.0.2.70", answer(s, "www.example.net", "A"))
    rr = s.api("/api/zones/records/get", zone="example.net", domain="child.example.net")["records"]
    check("local child zone, normal AXFR: parent-side delegation kept", any(r["type"] == "NS" for r in rr), str(rr)[:300])
    check("local child zone, normal AXFR: local zone answers its names", answer(s, "www.child.example.net", "A") == "192.0.2.80"
          and answer(s, "deep.child.example.net", "A") == "", answer(s, "deep.child.example.net", "A"))
    add("example.net", domain="deep2.child.example.net", type="A", ipAddress="192.0.2.83")
    add("example.net", domain="www2.example.net", type="A", ipAddress="192.0.2.71")
    wait_for(lambda: answer(s, "www2.example.net", "A") != "")
    check("local child zone, normal IXFR: parent records synced", answer(s, "www2.example.net", "A") == "192.0.2.71", answer(s, "www2.example.net", "A"))

    print("SUMMARY %s: %d/%d passed" % (IMAGE, sum(results), len(results)))


try:
    main()
finally:
    if "--keep" not in sys.argv:
        for c in (P, S):
            sh("docker", "rm", "-f", c, check=False)
        sh("docker", "network", "rm", NET, check=False)

sys.exit(0 if results and all(results) else 1)
