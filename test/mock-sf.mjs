#!/usr/bin/env node
// A fake Salesforce CLI used to test the MCP against real-world failure modes
// WITHOUT a live org. Behavior is driven by the SF_SCENARIO env var.
// It mimics how the real `sf ... --json` behaves, including non-zero exits
// that still print a JSON error body to stdout.

import { writeSync } from "fs"

const argv = process.argv.slice(2)
const scenario = process.env.SF_SCENARIO || "ok"

const SAMPLE_APEX = [
  "public with sharing class PaymentProcessor {",
  "    public PaymentProcessor() {}",
  "    @AuraEnabled",
  "    public static Decimal charge(Id accountId, Decimal amount) {",
  "        Account a = [SELECT Id, Name FROM Account WHERE Id = :accountId];",
  "        HttpRequest req = new HttpRequest();",
  "        Http h = new Http();",
  "        HttpResponse res = h.send(req);",
  "        Payment__c p = new Payment__c(Amount__c = amount);",
  "        insert p;",
  "        return amount;",
  "    }",
  "    private void log(String msg) { System.debug(msg); }",
  "}",
].join("\n")

function out(obj, exitCode = 0) {
  // Synchronous write to fd 1 — fully flushes even large payloads, and lets us
  // exit immediately so execution doesn't fall through to other branches.
  writeSync(1, JSON.stringify(obj))
  process.exit(exitCode)
}
function raw(text, exitCode = 0) {
  writeSync(1, text)
  process.exit(exitCode)
}
function has(flag) {
  return argv.includes(flag)
}
function flagVal(flag) {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}
function sub() {
  // the command words before the first --flag
  return argv.filter((a) => !a.startsWith("--"))
}

// ---- Global failure scenarios -------------------------------------------
if (scenario === "no_org") {
  out({ status: 1, name: "NoDefaultEnvError", message: "No default environment found. Use -o or set a default." }, 1)
}
if (scenario === "expired") {
  out({ status: 1, name: "INVALID_SESSION_ID", message: "INVALID_SESSION_ID: Session expired or invalid" }, 1)
}
if (scenario === "insufficient") {
  out({ status: 1, name: "INSUFFICIENT_ACCESS", message: "INSUFFICIENT_ACCESS_OR_READONLY: insufficient access rights on object id" }, 1)
}
if (scenario === "malformed") {
  out({ status: 1, name: "MALFORMED_QUERY", message: "MALFORMED_QUERY: unexpected token: 'FORM'" }, 1)
}
if (scenario === "badfield") {
  out({ status: 1, name: "INVALID_FIELD", message: "No such column 'Bogus__c' on entity 'Account'" }, 1)
}
if (scenario === "badjson") {
  raw("Warning: @salesforce/cli update available\n{ this is : not json", 1)
}
if (scenario === "banner_json") {
  // valid JSON preceded by a noisy banner — recoverJson should handle it
  raw('»   Warning: a new version is available\n' + JSON.stringify({ status: 0, result: { records: [{ Id: "001", Name: "Acme" }], totalSize: 1, done: true } }))
}
if (scenario === "timeout") {
  // Hang longer than the test's timeout; the parent kills us with SIGTERM.
  setTimeout(() => out({ status: 0, result: {} }), 10000)
} else {
  dispatch()
}

// ---- Normal ("ok") behavior, dispatched by subcommand -------------------
function dispatch() {
const s = sub()

// data query
if (s[0] === "data" && s[1] === "query") {
  const q = flagVal("--query") || ""

  if (scenario === "huge") {
    const records = Array.from({ length: 5000 }, (_, i) => ({
      attributes: { type: "Account", url: "/x" },
      Id: "001" + i,
      Name: "Acct " + i,
    }))
    out({ status: 0, result: { records, totalSize: records.length, done: true } })
  }

  // Coverage queries
  if (/ApexCodeCoverageAggregate/i.test(q)) {
    if (scenario === "empty_query") out({ status: 0, result: { records: [], totalSize: 0, done: true } })
    out({
      status: 0,
      result: {
        records: [
          { ApexClassOrTrigger: { Name: "AccountService" }, NumLinesCovered: 40, NumLinesUncovered: 10 },
          { ApexClassOrTrigger: { Name: "PaymentProcessor" }, NumLinesCovered: 12, NumLinesUncovered: 60 },
          { ApexClassOrTrigger: { Name: "OrphanUtil" }, NumLinesCovered: 0, NumLinesUncovered: 30 },
        ],
        totalSize: 3,
        done: true,
      },
    })
  }

  // ApexClass body queries (get_apex_class / analyze)
  if (/FROM ApexClass\b/i.test(q) && /Body/i.test(q)) {
    out({
      status: 0,
      result: {
        records: [
          {
            attributes: { type: "ApexClass", url: "/x" },
            Id: "01p000000000001",
            Name: "PaymentProcessor",
            ApiVersion: 59.0,
            Body: SAMPLE_APEX,
          },
        ],
        totalSize: 1,
        done: true,
      },
    })
  }

  // ApexClass list (no body)
  if (/FROM ApexClass\b/i.test(q)) {
    out({
      status: 0,
      result: {
        records: [
          { Id: "01p1", Name: "AccountService", Status: "Active", LastModifiedDate: "2026-06-01T00:00:00Z" },
          { Id: "01p2", Name: "PaymentProcessor", Status: "Active", LastModifiedDate: "2026-06-20T00:00:00Z" },
        ],
        totalSize: 2,
        done: true,
      },
    })
  }

  // User query (current_user)
  if (/FROM User\b/i.test(q)) {
    if (scenario === "empty_user") {
      out({ status: 0, result: { records: [], totalSize: 0, done: true } })
    }
    out({
      status: 0,
      result: {
        records: [
          { Id: "005x", Name: "Dev Admin", Email: "dev@x.com", Profile: { Name: "System Administrator" }, UserRole: null, IsActive: true },
        ],
        totalSize: 1,
        done: true,
      },
    })
  }

  // Empty Account result set (zero records)
  if (scenario === "empty_query") {
    out({ status: 0, result: { records: [], totalSize: 0, done: true } })
  }

  // Default: echo the query back so tests can prove it arrived intact (quote safety)
  out({
    status: 0,
    result: {
      records: [{ attributes: { type: "Account", url: "/x" }, Id: "001", Name: "Acme", _echoedQuery: q }],
      totalSize: 1,
      done: true,
    },
  })
}

// sobject describe
if (s[0] === "sobject" && s[1] === "describe") {
  const name = flagVal("--sobject")
  if (scenario === "bad_object") {
    out({ status: 1, name: "INVALID_TYPE", message: `sObject type '${name}' is not supported.` }, 1)
  }
  out({
    status: 0,
    result: {
      name,
      label: name,
      custom: name.endsWith("__c"),
      createable: true,
      updateable: true,
      deletable: true,
      queryable: true,
      fields: [
        { name: "Id", label: "Record ID", type: "id", nillable: false, defaultedOnCreate: true, unique: true },
        { name: "Name", label: "Name", type: "string", length: 80, nillable: false, defaultedOnCreate: false, unique: false },
        { name: "Amount__c", label: "Amount", type: "currency", nillable: true, defaultedOnCreate: false, unique: false },
        { name: "Stage__c", label: "Stage", type: "picklist", nillable: true, defaultedOnCreate: false, picklistValues: [{ value: "New", active: true }, { value: "Closed", active: false }] },
      ],
    },
  })
}

// sobject list
if (s[0] === "sobject" && s[1] === "list") {
  out({ status: 0, result: ["Account", "Contact", "Opportunity", "Payment__c"] })
}

// org display
if (s[0] === "org" && s[1] === "display") {
  out({
    status: 0,
    result: {
      username: "dev@example.com",
      id: "00Dxx0000001gPF",
      instanceUrl: "https://example.my.salesforce.com",
      alias: "myorg",
      connectedStatus: "Connected",
      apiVersion: "59.0",
      expirationDate: null,
    },
  })
}

// org list limits
if (s[0] === "org" && s[1] === "list" && s[2] === "limits") {
  if (scenario === "empty_limits") out({ status: 0, result: [] })
  out({
    status: 0,
    result: [
      { name: "DailyApiRequests", max: 15000, remaining: 1200 }, // 92% used -> critical
      { name: "DataStorageMB", max: 1024, remaining: 800 }, // 22% used
    ],
  })
}

// org list metadata
if (s[0] === "org" && s[1] === "list" && s[2] === "metadata") {
  const type = flagVal("--metadata-type")
  if (type === "Flow") {
    out({
      status: 0,
      result: [
        { fullName: "Onboarding_Flow", type: "Flow" },
        { fullName: "Account_Sync", type: "Flow" },
      ],
    })
  }
  out({ status: 0, result: [] })
}

// org list
if (s[0] === "org" && s[1] === "list") {
  if (scenario === "empty_orgs") out({ status: 0, result: { nonScratchOrgs: [], scratchOrgs: [] } })
  out({
    status: 0,
    result: {
      nonScratchOrgs: [
        { alias: "myorg", username: "dev@example.com", orgId: "00Dxx", instanceUrl: "https://example.my.salesforce.com", isDefaultUsername: true, connectedStatus: "Connected" },
      ],
      scratchOrgs: [],
    },
  })
}

// apex run
if (s[0] === "apex" && s[1] === "run") {
  if (scenario === "apex_exception") {
    // Compiles fine, but throws at runtime — status stays 0, success is false.
    out({
      status: 0,
      result: {
        success: false,
        compiled: true,
        compileProblem: "",
        exceptionMessage: "System.NullPointerException: Attempt to de-reference a null object",
        exceptionStackTrace: "AnonymousBlock: line 2, column 1",
        line: 2,
        column: 1,
        logs: "USER_DEBUG|boom\n",
      },
    })
  }
  out({
    status: 0,
    result: { success: true, compiled: true, compileProblem: null, exceptionMessage: null, logs: "USER_DEBUG|Hello\n" },
  })
}

// Unknown command
out({ status: 1, name: "UnknownCommand", message: "Unknown sf command: " + argv.join(" ") }, 1)
}
