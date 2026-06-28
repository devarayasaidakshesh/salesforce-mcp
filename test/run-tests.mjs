// Negative + positive scenario tests for the Salesforce MCP.
// Runs every tool against a mock `sf` CLI — no live org required.
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const MOCK = join(__dirname, "mock-sf.mjs")

// Point the MCP at the mock CLI and use a short timeout for the timeout test.
process.env.SF_MCP_BIN = MOCK
process.env.SF_MCP_TIMEOUT_MS = "1500"

const { handleQuery } = await import("../tools/query.js")
const { handleSchema } = await import("../tools/schema.js")
const { handleApex } = await import("../tools/apex.js")
const { handleOrg } = await import("../tools/org.js")
const { handleTestgen } = await import("../tools/testgen.js")
const { handlePackage } = await import("../tools/packagexml.js")

let passed = 0
let failed = 0
const failures = []

function setScenario(s) {
  if (s) process.env.SF_SCENARIO = s
  else delete process.env.SF_SCENARIO
}

async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed++
    failures.push({ name, message: e.message })
    console.log(`  ❌ ${name}\n       ${e.message}`)
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed")
}
async function expectError(fn, substr) {
  try {
    await fn()
  } catch (e) {
    assert(
      e.message.toLowerCase().includes(substr.toLowerCase()),
      `expected error containing "${substr}", got "${e.message}"`
    )
    return
  }
  throw new Error(`expected an error containing "${substr}", but none was thrown`)
}

console.log("\n=== Salesforce MCP — scenario tests ===\n")

// ---------- Positive paths ----------
console.log("Positive paths:")
setScenario("ok")

await test("soql_query returns records", async () => {
  const r = await handleQuery("soql_query", { query: "SELECT Id, Name FROM Account LIMIT 5" })
  assert(r.records.length === 1 && r.records[0].Name === "Acme", "unexpected records")
  assert(!("attributes" in r.records[0]), "attributes metadata was not stripped")
})

await test("SOQL with embedded quotes arrives intact (no shell breakage)", async () => {
  const tricky = `SELECT Id FROM Account WHERE Name = 'O''Brien "Co" & Sons' LIMIT 1`
  const r = await handleQuery("soql_query", { query: tricky })
  assert(r.records[0]._echoedQuery === tricky, "query was mangled in transit:\n   " + r.records[0]._echoedQuery)
})

await test("describe_object returns compact fields + picklists", async () => {
  const r = await handleSchema("describe_object", { object_name: "Opportunity" })
  assert(r.fieldCount === 4, "wrong field count")
  const stage = r.fields.find((f) => f.apiName === "Stage__c")
  assert(stage.picklistValues.length === 1 && stage.picklistValues[0] === "New", "inactive picklist not filtered")
})

await test("list_objects filters + sorts", async () => {
  const r = await handleSchema("list_objects", { filter: "acc" })
  assert(r.objects.includes("Account") && r.count === 1, "filter failed")
})

await test("org_info maps org id", async () => {
  const r = await handleOrg("org_info", {})
  assert(r.orgId === "00Dxx0000001gPF" && r.connectedStatus === "Connected", "org info wrong")
})

await test("org_limits computes used + flags critical (>80%)", async () => {
  const r = await handleOrg("org_limits", {})
  const api = r.allLimits.find((l) => l.name === "DailyApiRequests")
  assert(api.used === 13800, "used miscomputed: " + api.used)
  assert(api.percentUsed === 92, "percent miscomputed: " + api.percentUsed)
  assert(r.criticalLimits.length === 1 && r.warning, "critical limit not flagged")
})

await test("list_orgs aggregates + marks default", async () => {
  const r = await handleOrg("list_orgs", {})
  assert(r.count === 1 && r.orgs[0].isDefault === true, "list_orgs wrong")
})

await test("current_user resolves profile", async () => {
  const r = await handleOrg("current_user", {})
  assert(r.name === "Dev Admin" && r.profile === "System Administrator", "user wrong")
})

await test("run_apex returns logs + compile status", async () => {
  const r = await handleApex("run_apex", { code: "System.debug('hi');" })
  assert(r.success === true && r.compiled === true && r.logs.includes("Hello"), "apex run wrong")
})

await test("list_apex_classes stays compact (no bodies)", async () => {
  const r = await handleApex("list_apex_classes", {})
  assert(r.count === 2 && !("body" in r.classes[0]), "apex list wrong")
})

// ---------- Test generator intelligence ----------
console.log("\nTest generator:")
setScenario("ok")

await test("analyze_apex_class detects DML, SOQL, callouts, controller, sharing", async () => {
  const r = await handleTestgen("analyze_apex_class", { class_name: "PaymentProcessor" })
  const a = r.analysis
  assert(a.sharing === "with sharing", "sharing not detected: " + a.sharing)
  assert(a.dmlOperations.includes("insert"), "insert DML not detected")
  assert(a.soqlObjects.includes("Account"), "SOQL object not detected")
  assert(a.httpCallout === true, "HTTP callout not detected")
  assert(a.isController === true, "controller (@AuraEnabled) not detected")
  const charge = a.methods.find((m) => m.name === "charge")
  assert(charge && charge.paramList.length === 2, "method signature not parsed")
  assert(r.testScaffold.includes("TestCalloutMock"), "callout mock not scaffolded")
  assert(r.guidance.some((g) => /callout/i.test(g)), "callout guidance missing")
})

await test("check_coverage computes percentage", async () => {
  const r = await handleTestgen("check_coverage", { class_name: "*" })
  const pp = r.coverage.find((c) => c.className === "PaymentProcessor")
  assert(pp.coveragePercent === 17 && pp.meetsMinimum === false, "coverage calc wrong: " + pp.coveragePercent)
})

await test("list_untested_classes filters + sorts lowest first", async () => {
  const r = await handleTestgen("list_untested_classes", {})
  assert(r.count === 2, "wrong untested count: " + r.count)
  assert(r.classes[0].className === "OrphanUtil", "not sorted lowest-first")
  assert(!r.classes.find((c) => c.className === "AccountService"), "80% class should be excluded")
})

// ---------- package.xml builder ----------
console.log("\npackage.xml builder:")
setScenario("ok")

await test("build_package_xml produces valid sorted manifest", async () => {
  const r = await handlePackage("build_package_xml", {
    components: [
      { type: "ApexClass", members: ["Zeta", "Alpha"] },
      { type: "Flow", members: ["My_Flow"] },
    ],
    api_version: "59",
  })
  // Types sorted: ApexClass before Flow; members sorted: Alpha before Zeta.
  assert(r.packageXml.indexOf("<name>ApexClass</name>") < r.packageXml.indexOf("<name>Flow</name>"), "types not sorted")
  assert(r.packageXml.indexOf("Alpha") < r.packageXml.indexOf("Zeta"), "members not sorted")
  assert(r.packageXml.includes("<version>59.0</version>"), "api version not normalized to 59.0")
  assert(r.packageXml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), "missing xml prolog")
  assert(r.usage.deploy.includes("--manifest"), "deploy command missing")
})

await test("friendly type aliases are normalized", async () => {
  const r = await handlePackage("build_package_xml", {
    components: [
      { type: "lwc", members: ["myCmp"] },
      { type: "permission set", members: ["Admin_PS"] },
      { type: "class", members: ["Foo"] },
    ],
  })
  assert(r.packageXml.includes("<name>LightningComponentBundle</name>"), "lwc alias failed")
  assert(r.packageXml.includes("<name>PermissionSet</name>"), "permission set alias failed")
  assert(r.packageXml.includes("<name>ApexClass</name>"), "class alias failed")
  assert(r.apiVersion === "59.0", "default api version wrong")
})

await test("duplicate members merged across components of same type", async () => {
  const r = await handlePackage("build_package_xml", {
    components: [
      { type: "Flow", members: ["A", "B"] },
      { type: "flow", members: ["B", "C"] },
    ],
  })
  const matches = r.packageXml.match(/<members>/g) || []
  assert(matches.length === 3, "members not deduped/merged: " + matches.length)
})

await test("XML special characters are escaped", async () => {
  const r = await handlePackage("build_package_xml", {
    components: [{ type: "CustomLabels", members: ["A & B <test>"] }],
  })
  assert(r.packageXml.includes("A &amp; B &lt;test&gt;"), "xml not escaped")
})

await test("wildcard on folder-based type warns", async () => {
  const r = await handlePackage("build_package_xml", {
    components: [{ type: "Report", members: ["*"] }],
  })
  assert(r.warnings && r.warnings.some((w) => /folder-based/.test(w)), "folder warning missing")
})

await test("CustomField requires Object.Field (dot) — warns when missing", async () => {
  const bad = await handlePackage("build_package_xml", {
    components: [{ type: "field", members: ["Region__c"] }],
  })
  assert(bad.warnings && bad.warnings.some((w) => /CustomField member 'Region__c'/.test(w)), "missing dot not warned")
  const good = await handlePackage("build_package_xml", {
    components: [{ type: "field", members: ["Account.Region__c"] }],
  })
  assert(!good.warnings || !good.warnings.some((w) => /Region__c/.test(w)), "valid field should not warn")
})

await test("Layout requires Object-Layout Name (hyphen) — warns when missing", async () => {
  const bad = await handlePackage("build_package_xml", {
    components: [{ type: "layout", members: ["Account Layout"] }],
  })
  assert(bad.warnings && bad.warnings.some((w) => /Layout member/.test(w) && /'-'/.test(w)), "layout hyphen not warned")
  const good = await handlePackage("build_package_xml", {
    components: [{ type: "layout", members: ["Account-Account Layout"] }],
  })
  assert(!good.warnings || !good.warnings.some((w) => /Layout member/.test(w)), "valid layout should not warn")
  assert(good.packageXml.includes("<members>Account-Account Layout</members>"), "layout member not emitted")
})

await test("CustomLabel (singular) vs CustomLabels (plural) map correctly", async () => {
  const single = await handlePackage("build_package_xml", {
    components: [{ type: "custom label", members: ["Welcome_Message"] }],
  })
  assert(single.packageXml.includes("<name>CustomLabel</name>"), "individual label should map to CustomLabel")
  const plural = await handlePackage("build_package_xml", {
    components: [{ type: "custom labels", members: ["CustomLabels"] }],
  })
  assert(plural.packageXml.includes("<name>CustomLabels</name>"), "container should map to CustomLabels")
})

await test("RecordType + ValidationRule dot-format accepted", async () => {
  const r = await handlePackage("build_package_xml", {
    components: [
      { type: "RecordType", members: ["Account.Partner"] },
      { type: "ValidationRule", members: ["Account.Require_Region"] },
    ],
  })
  assert(!r.warnings, "valid compound members should produce no warnings: " + JSON.stringify(r.warnings))
})

await test("mixed real-world manifest (flow + labels + field + object)", async () => {
  const r = await handlePackage("build_package_xml", {
    components: [
      { type: "flow", members: ["Onboarding"] },
      { type: "custom label", members: ["Welcome_Message"] },
      { type: "field", members: ["Account.Region__c"] },
      { type: "object", members: ["Region__c"] },
    ],
  })
  for (const n of ["<name>Flow</name>", "<name>CustomLabel</name>", "<name>CustomField</name>", "<name>CustomObject</name>"]) {
    assert(r.packageXml.includes(n), "missing block: " + n)
  }
  assert(!r.warnings, "well-formed manifest should have no warnings: " + JSON.stringify(r.warnings))
})

await test("unknown metadata type rejected", async () => {
  await expectError(
    () => handlePackage("build_package_xml", { components: [{ type: "Not A Type!", members: ["x"] }] }),
    "not a recognized metadata type"
  )
})

await test("empty components rejected", async () => {
  await expectError(() => handlePackage("build_package_xml", { components: [] }), "non-empty 'components'")
})

await test("list_metadata_components returns sorted fullNames", async () => {
  const r = await handlePackage("list_metadata_components", { metadata_type: "Flow", target_org: "x" })
  assert(r.count === 2 && r.members[0] === "Account_Sync", "metadata listing wrong")
})

await test("folder-based listing without folder is rejected", async () => {
  await expectError(
    () => handlePackage("list_metadata_components", { metadata_type: "Report" }),
    "folder-based"
  )
})

// ---------- Negative / failure scenarios ----------
console.log("\nFailure scenarios:")

await test("no connected org -> friendly guidance", async () => {
  setScenario("no_org")
  await expectError(() => handleOrg("org_info", {}), "No Salesforce org is connected")
})

await test("expired session -> re-auth guidance", async () => {
  setScenario("expired")
  await expectError(() => handleQuery("soql_query", { query: "SELECT Id FROM Account" }), "session has expired")
})

await test("malformed JSON output -> friendly message", async () => {
  setScenario("badjson")
  await expectError(() => handleOrg("org_info", {}), "Could not understand")
})

await test("banner before JSON is recovered", async () => {
  setScenario("banner_json")
  const r = await handleQuery("soql_query", { query: "SELECT Id FROM Account" })
  assert(r.records[0].Name === "Acme", "did not recover JSON from noisy output")
})

await test("invalid object -> actionable error", async () => {
  setScenario("bad_object")
  await expectError(() => handleSchema("describe_object", { object_name: "Account" }), "API name")
})

await test("query timeout -> friendly timeout message", async () => {
  setScenario("timeout")
  await expectError(() => handleQuery("soql_query", { query: "SELECT Id FROM Account" }), "timed out")
})

// ---------- Input validation (no CLI call at all) ----------
console.log("\nInput validation:")
setScenario("ok")

await test("non-SELECT query rejected (read-only safety)", async () => {
  await expectError(
    () => handleQuery("soql_query", { query: "DELETE FROM Account" }),
    "Only SELECT"
  )
})

await test("invalid object name rejected before CLI call", async () => {
  await expectError(() => handleSchema("describe_object", { object_name: "Account; DROP" }), "valid Salesforce object")
})

await test("empty apex code rejected", async () => {
  await expectError(() => handleApex("run_apex", { code: "   " }), "cannot be empty")
})

// ---------- Huge result protection ----------
console.log("\nContext protection:")
await test("huge result is capped with a note", async () => {
  setScenario("huge")
  const r = await handleQuery("soql_query", { query: "SELECT Id FROM Account" })
  assert(r.truncated === true, "not truncated")
  assert(r.returnedCount === 200, "cap not applied: " + r.returnedCount)
  assert(r.totalSize === 5000 && r.note, "totalSize/note missing")
})

// ---------- CLI-not-installed (fresh module, bad bin) ----------
console.log("\nEnvironment:")
await test("missing sf CLI -> install instructions", async () => {
  const prevBin = process.env.SF_MCP_BIN
  process.env.SF_MCP_BIN = "/nonexistent/path/to/sf-binary"
  const { runSF } = await import("../utils/sf.js?fresh=enoent")
  try {
    await expectError(() => runSF(["org", "display"]), "was not found")
  } finally {
    process.env.SF_MCP_BIN = prevBin
  }
})

// ---------- Extended edge cases ----------
console.log("\nExtended: error mapping:")

await test("insufficient access -> permission guidance", async () => {
  setScenario("insufficient")
  await expectError(() => handleQuery("soql_query", { query: "SELECT Id FROM Account" }), "permission")
})

await test("malformed query -> syntax guidance", async () => {
  setScenario("malformed")
  await expectError(() => handleQuery("soql_query", { query: "SELECT Id FORM Account" }), "syntax error")
})

await test("bad field -> check API names guidance", async () => {
  setScenario("badfield")
  await expectError(() => handleQuery("soql_query", { query: "SELECT Bogus__c FROM Account" }), "API name")
})

await test("runtime apex exception surfaced (compiles, fails at run)", async () => {
  setScenario("apex_exception")
  const r = await handleApex("run_apex", { code: "Account a; a.Name = 'x';" })
  assert(r.compiled === true && r.success === false, "should compile but fail")
  assert(/NullPointerException/.test(r.exceptionMessage), "exception not surfaced")
})

console.log("\nExtended: empty results:")
setScenario("empty_query")
await test("zero-record query returns clean empty set", async () => {
  const r = await handleQuery("soql_query", { query: "SELECT Id FROM Account WHERE Name='nope'" })
  assert(r.records.length === 0 && r.totalSize === 0 && r.truncated === false, "empty handling wrong")
})

await test("current_user with no User row returns a note, not a crash", async () => {
  setScenario("empty_user")
  const r = await handleOrg("current_user", {})
  assert(r.username && r.note && /could not load/i.test(r.note), "missing note path")
})

await test("org_limits with no limits returns empty, no crash", async () => {
  setScenario("empty_limits")
  const r = await handleOrg("org_limits", {})
  assert(r.totalLimits === 0 && r.criticalLimits.length === 0, "empty limits wrong")
})

await test("list_orgs with none -> count 0 + login hint", async () => {
  setScenario("empty_orgs")
  const r = await handleOrg("list_orgs", {})
  assert(r.count === 0 && /login/i.test(r.hint), "missing empty-orgs hint")
})

await test("list_untested_classes with no coverage data -> note", async () => {
  setScenario("empty_query")
  const r = await handleTestgen("list_untested_classes", {})
  assert(r.count === 0 && /no coverage data/i.test(r.note), "missing coverage note")
})

await test("check_coverage with no data -> run-tests note", async () => {
  setScenario("empty_query")
  const r = await handleTestgen("check_coverage", { class_name: "Foo" })
  assert(r.count === 0 && /tests have run|run tests/i.test(r.note), "missing coverage note")
})

console.log("\nExtended: input validation:")
setScenario("ok")

await test("missing query param rejected", async () => {
  await expectError(() => handleQuery("soql_query", {}), "non-empty")
})

await test("whitespace-only query rejected", async () => {
  await expectError(() => handleQuery("soql_query", { query: "   " }), "non-empty")
})

await test("soql_query_all also enforces SELECT-only", async () => {
  await expectError(() => handleQuery("soql_query_all", { query: "UPDATE Account SET x=1" }), "Only SELECT")
})

await test("describe_object missing object_name rejected", async () => {
  await expectError(() => handleSchema("describe_object", {}), "valid Salesforce object")
})

await test("find_field with no match returns hint", async () => {
  const r = await handleSchema("find_field", { object_name: "Opportunity", field_search: "zzz_nope" })
  assert(r.matchCount === 0 && r.hint, "missing no-match hint")
})

await test("get_apex_class invalid name rejected before CLI", async () => {
  await expectError(() => handleApex("get_apex_class", { class_name: "1Bad-Name" }), "valid Apex class name")
})

await test("custom max_records caps lower than default", async () => {
  setScenario("huge")
  const r = await handleQuery("soql_query", { query: "SELECT Id FROM Account", max_records: 10 })
  assert(r.returnedCount === 10 && r.truncated === true, "custom max_records ignored")
})

console.log("\nExtended: package.xml robustness:")
setScenario("ok")

await test("api_version normalizes integer-like input (58 -> 58.0)", async () => {
  const r = await handlePackage("build_package_xml", { components: [{ type: "Flow", members: ["F"] }], api_version: "58" })
  assert(r.packageXml.includes("<version>58.0</version>"), "version not normalized")
})

await test("blank/whitespace members are dropped", async () => {
  const r = await handlePackage("build_package_xml", { components: [{ type: "Flow", members: ["A", "  ", ""] }] })
  const count = (r.packageXml.match(/<members>/g) || []).length
  assert(count === 1, "blank members not dropped: " + count)
})

await test("type aliases are case/space-insensitive", async () => {
  const r = await handlePackage("build_package_xml", { components: [{ type: "  FLOW  ", members: ["F"] }] })
  assert(r.packageXml.includes("<name>Flow</name>"), "alias normalization case-insensitive failed")
})

await test("wildcard coexists with named members, sorted first", async () => {
  const r = await handlePackage("build_package_xml", { components: [{ type: "ApexClass", members: ["Zed", "*", "Abe"] }] })
  const seg = r.packageXml.slice(r.packageXml.indexOf("<types>"))
  assert(seg.indexOf("*") < seg.indexOf("Abe"), "wildcard not first")
})

await test("component missing members rejected", async () => {
  await expectError(() => handlePackage("build_package_xml", { components: [{ type: "Flow" }] }), "non-empty 'members'")
})

await test("list_metadata_components empty -> note", async () => {
  const r = await handlePackage("list_metadata_components", { metadata_type: "ApexClass", target_org: "x" })
  assert(r.count === 0 && r.note, "missing empty note")
})

await test("CustomLabels plural with '*' produces no warning", async () => {
  const r = await handlePackage("build_package_xml", { components: [{ type: "custom labels", members: ["*"] }] })
  assert(!r.warnings, "plural CustomLabels with wildcard should not warn")
})

// ---------- Summary ----------
console.log(`\n=== ${passed} passed, ${failed} failed ===\n`)
if (failed > 0) {
  console.log("Failures:")
  for (const f of failures) console.log(` - ${f.name}: ${f.message}`)
  process.exit(1)
}
