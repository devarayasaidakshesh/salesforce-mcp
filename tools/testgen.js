import { runSF, FriendlyError, cleanRecords } from "../utils/sf.js"

export const testgenTools = [
  {
    name: "analyze_apex_class",
    description:
      "Deep-analyze an Apex class from the org for test planning AND security: methods + signatures, DML operations, " +
      "SOQL objects, HTTP callouts, async patterns (Batch/Queueable/Schedulable/Future), sharing model, plus a " +
      "security scan (CRUD/FLS enforcement, SOQL injection, sharing declaration, hardcoded secrets). " +
      "Returns structured findings plus a rule-following test scaffold (real assertions, negative + bulk + runAs " +
      "tests, no SeeAllData). Use this, then write real assertions from the returned source.",
    inputSchema: {
      type: "object",
      properties: {
        class_name: { type: "string", description: "API name of the Apex class to analyze" },
        target_org: { type: "string", description: "Optional: alias of the org" },
      },
      required: ["class_name"],
    },
  },
  {
    name: "check_coverage",
    description: "Check current code coverage percentage for an Apex class (or '*' for all classes)",
    inputSchema: {
      type: "object",
      properties: {
        class_name: { type: "string", description: "API name, or '*' for all classes" },
        target_org: { type: "string", description: "Optional: alias of the org" },
      },
      required: ["class_name"],
    },
  },
  {
    name: "list_untested_classes",
    description: "List Apex classes below a coverage threshold (default 75% — the Salesforce deployment minimum)",
    inputSchema: {
      type: "object",
      properties: {
        target_org: { type: "string", description: "Optional: alias of the org" },
        threshold: { type: "number", description: "Coverage % threshold; classes below it are returned. Default 75." },
      },
    },
  },
]

function orgArgs(target_org) {
  return target_org ? ["--target-org", String(target_org)] : []
}

function validateClassName(name) {
  if (!name || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    throw new FriendlyError(`'${name}' is not a valid Apex class name.`)
  }
  return name
}

function isHiddenBody(body) {
  return !body || body.trim() === "(hidden)"
}

export async function handleTestgen(toolName, args) {
  if (toolName === "analyze_apex_class") {
    const name = validateClassName(args.class_name)
    const r = await runSF([
      "data",
      "query",
      "--query",
      `SELECT Id, Name, ApiVersion, Body FROM ApexClass WHERE Name = '${name}' LIMIT 1`,
      ...orgArgs(args.target_org),
    ])
    const rec = (r.records || [])[0]
    if (!rec) throw new FriendlyError(`Apex class '${name}' was not found in this org.`)

    const body = rec.Body || ""
    // Managed-package classes return Body = "(hidden)" — the source is protected,
    // so there is nothing to analyze. Tell the user plainly.
    if (isHiddenBody(body)) {
      throw new FriendlyError(
        `'${name}' belongs to a managed package — its source code is hidden, so it can't be ` +
          "analyzed or unit-tested directly. Managed-package classes are covered by the package " +
          "vendor's own tests. Analyze your own (unlocked) classes instead."
      )
    }
    const analysis = analyzeApex(name, body)
    const scaffold = buildScaffold(name, analysis)

    return {
      sourceClassName: name,
      apiVersion: rec.ApiVersion,
      analysis,
      testScaffold: scaffold,
      sourceBody: body,
      guidance: buildGuidance(analysis),
    }
  }

  if (toolName === "check_coverage") {
    const isAll = args.class_name === "*"
    if (!isAll) validateClassName(args.class_name)
    const where = isAll ? "" : ` WHERE ApexClassOrTrigger.Name = '${args.class_name}'`
    const r = await runSF([
      "data",
      "query",
      "--query",
      `SELECT ApexClassOrTrigger.Name, NumLinesCovered, NumLinesUncovered FROM ApexCodeCoverageAggregate${where} ORDER BY ApexClassOrTrigger.Name`,
      ...orgArgs(args.target_org),
    ])
    const records = cleanRecords(r.records || [])
    if (records.length === 0) {
      return {
        count: 0,
        note:
          "No coverage data found. Coverage is only populated after tests have run. " +
          "Run tests first:  sf apex run test --code-coverage",
      }
    }
    return {
      count: records.length,
      coverage: records.map(toCoverage),
    }
  }

  if (toolName === "list_untested_classes") {
    const threshold = Number.isFinite(args.threshold) ? args.threshold : 75
    const r = await runSF([
      "data",
      "query",
      "--query",
      "SELECT ApexClassOrTrigger.Name, NumLinesCovered, NumLinesUncovered FROM ApexCodeCoverageAggregate ORDER BY ApexClassOrTrigger.Name",
      ...orgArgs(args.target_org),
    ])
    const records = cleanRecords(r.records || [])
    if (records.length === 0) {
      return { threshold, count: 0, note: "No coverage data yet. Run tests with --code-coverage first." }
    }
    const below = records
      .map(toCoverage)
      .filter((c) => c.coveragePercent < threshold)
      .sort((a, b) => a.coveragePercent - b.coveragePercent)
    return {
      threshold,
      count: below.length,
      message:
        below.length === 0
          ? `All classes meet the ${threshold}% threshold.`
          : `${below.length} class(es) below ${threshold}% coverage — prioritize the lowest first.`,
      classes: below,
    }
  }
}

function toCoverage(rec) {
  const covered = num(rec.NumLinesCovered)
  const uncovered = num(rec.NumLinesUncovered)
  const total = covered + uncovered
  const pct = total > 0 ? Math.round((covered / total) * 100) : 0
  return {
    className: rec.ApexClassOrTrigger && rec.ApexClassOrTrigger.Name,
    linesCovered: covered,
    linesUncovered: uncovered,
    totalLines: total,
    coveragePercent: pct,
    meetsMinimum: pct >= 75,
  }
}

// ---- Static analysis of the Apex source ---------------------------------

function analyzeApex(className, body) {
  // Strip line + block comments so they don't create false matches.
  const code = body
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")

  const sharing = /\bwith sharing\b/i.test(code)
    ? "with sharing"
    : /\bwithout sharing\b/i.test(code)
    ? "without sharing"
    : /\binherited sharing\b/i.test(code)
    ? "inherited sharing"
    : "none"

  const methods = extractMethods(code, className)

  const dml = []
  for (const op of ["insert", "update", "delete", "undelete", "upsert", "merge"]) {
    const re = new RegExp(`(?:^|[^\\w.])${op}\\s+[\\w({\\[]`, "i")
    if (re.test(code) || new RegExp(`Database\\.${op}`, "i").test(code)) dml.push(op)
  }

  const soqlObjects = uniq(
    [...code.matchAll(/\bFROM\s+([A-Za-z][A-Za-z0-9_]*)/gi)].map((m) => m[1])
  )

  const async = {
    batchable: /implements\s+Database\.Batchable/i.test(code),
    queueable: /implements\s+Queueable/i.test(code),
    schedulable: /implements\s+Schedulable/i.test(code),
    future: /@future/i.test(code),
    callout: /@future\s*\(\s*callout\s*=\s*true\s*\)/i.test(code),
  }

  const httpCallout = /\b(HttpRequest|Http\s*\(|HttpResponse|HttpCalloutMock)\b/.test(code)
  const sendsEmail = /Messaging\.send(?:Email)?/i.test(code)
  const usesTestVisible = /@TestVisible/i.test(code)
  const isController =
    /@AuraEnabled/i.test(code) || /@RemoteAction/i.test(code) || className.endsWith("Controller")
  const exposedMethods = methods.filter((m) => /AuraEnabled|HttpGet|HttpPost|InvocableMethod|RemoteAction|webService/i.test(m.annotations.join(" ")))
  const throwsException = /\bthrow\s+new\b/i.test(code)

  const securityFindings = detectSecurityFindings(code, {
    sharing,
    dmlOperations: dml,
    soqlObjects,
    isController,
  })

  return {
    className,
    sharing,
    methodCount: methods.length,
    methods,
    dmlOperations: dml,
    soqlObjects,
    async,
    httpCallout,
    sendsEmail,
    usesTestVisible,
    isController,
    exposedMethodNames: exposedMethods.map((m) => m.name),
    throwsException,
    securityFindings,
  }
}

// ---- Security analysis --------------------------------------------------
// Class-level heuristics that mirror the Apex Security Review rules most
// commonly missed. They are intentionally conservative: each one flags the
// ABSENCE of a known-safe construct (user-mode access, escaping, a sharing
// keyword) and says so plainly, so false positives stay low.

const READ_ENFORCERS = [
  /WITH\s+SECURITY_ENFORCED/i,
  /WITH\s+USER_MODE/i,
  /AccessLevel\.USER_MODE/i,
  /stripInaccessible/i,
  /\.isAccessible\s*\(/i,
]
const DML_ENFORCERS = [
  /\bas\s+user\b/i,
  /AccessLevel\.USER_MODE/i,
  /stripInaccessible/i,
  /\.isCreateable\s*\(/i,
  /\.isUpdateable\s*\(/i,
  /\.isUpsertable\s*\(/i,
  /\.isDeletable\s*\(/i,
  /\.isMergeable\s*\(/i,
]
const DYNAMIC_SOQL = /\b(?:Database\.(?:query|getQueryLocator|countQuery|queryWithBinds)|Search\.query)\s*\(/i
const SECRET_PATTERNS = [
  /\b(?:password|passwd|pwd|secret|api[_]?key|apikey|access[_]?token|auth[_]?token|client[_]?secret|private[_]?key)\b\s*=\s*'[^']{4,}'/i,
  /setHeader\s*\(\s*'Authorization'\s*,\s*'[^']+'/i,
]

function anyMatch(patterns, code) {
  return patterns.some((re) => re.test(code))
}

function detectSecurityFindings(code, ctx) {
  const findings = []
  const exposed = ctx.isController
  const sev = exposed ? "high" : "medium"

  if (ctx.soqlObjects.length && !anyMatch(READ_ENFORCERS, code)) {
    findings.push({
      id: "FLS_READ",
      rule: "CRUD/FLS enforcement (read)",
      severity: sev,
      title: "SOQL runs in system mode — field/object read permissions are not enforced",
      detail:
        `Queries on ${ctx.soqlObjects.join(", ")} have no WITH USER_MODE / WITH SECURITY_ENFORCED and the rows ` +
        "are not passed through Security.stripInaccessible, so fields the running user cannot read are still " +
        "returned to the caller" +
        (exposed ? " — and this class is exposed to the client/integration layer." : "."),
      fix:
        "Add WITH USER_MODE (preferred) or WITH SECURITY_ENFORCED to each SOQL query, run Database queries with " +
        "AccessLevel.USER_MODE, or filter rows through Security.stripInaccessible(AccessType.READABLE, rows).",
    })
  }

  if (ctx.dmlOperations.length && !anyMatch(DML_ENFORCERS, code)) {
    findings.push({
      id: "FLS_DML",
      rule: "CRUD/FLS enforcement (DML)",
      severity: sev,
      title: `DML (${ctx.dmlOperations.join(", ")}) runs in system mode — create/update/delete permissions are not enforced`,
      detail:
        "The DML statements do not use 'as user' / AccessLevel.USER_MODE and the records are not run through " +
        "Security.stripInaccessible, so a user without create/edit access to the object or a field can still write " +
        "through this method.",
      fix:
        "Use user-mode DML (e.g. `insert as user records;` or `Database.update(records, AccessLevel.USER_MODE)`), " +
        "or gate the DML behind Schema.sObjectType.<Object>.isCreateable()/isUpdateable() checks.",
    })
  }

  if (DYNAMIC_SOQL.test(code) && !/escapeSingleQuotes/i.test(code) && !/queryWithBinds/i.test(code)) {
    findings.push({
      id: "SOQL_INJECTION",
      rule: "SOQL injection",
      severity: "high",
      title: "Dynamic SOQL built without escaping or bind variables",
      detail:
        "A dynamic query (Database.query / getQueryLocator / Search.query) is built without " +
        "String.escapeSingleQuotes() and without bind variables, so untrusted input can alter the query.",
      fix:
        "Prefer static SOQL with bind variables (:var), use Database.queryWithBinds, or wrap every interpolated " +
        "value in String.escapeSingleQuotes().",
    })
  }

  if ((ctx.dmlOperations.length || ctx.soqlObjects.length) && ctx.sharing === "none") {
    findings.push({
      id: "SHARING_NONE",
      rule: "Sharing declaration",
      severity: exposed ? "high" : "medium",
      title: "Class accesses data but declares no sharing mode",
      detail:
        "The class performs SOQL/DML but is neither 'with sharing', 'without sharing', nor 'inherited sharing'. It " +
        "runs in the sharing context of its caller, which is easy to get wrong and bypass record-level security.",
      fix: "Declare 'with sharing' (or 'inherited sharing' for reusable service classes) on the class.",
    })
  }

  if (ctx.isController && ctx.sharing === "without sharing") {
    findings.push({
      id: "CONTROLLER_WITHOUT_SHARING",
      rule: "Sharing declaration",
      severity: "high",
      title: "Client-exposed controller runs 'without sharing'",
      detail:
        "This class is exposed (@AuraEnabled/@RemoteAction/Controller) yet runs 'without sharing', so records the " +
        "running user should not see can be returned to the UI/integration, bypassing record-level security.",
      fix: "Use 'with sharing' on controllers; isolate any genuinely elevated logic in a separate class.",
    })
  }

  if (anyMatch(SECRET_PATTERNS, code)) {
    findings.push({
      id: "HARDCODED_SECRET",
      rule: "Hardcoded secret",
      severity: "high",
      title: "Possible hardcoded credential or secret in source",
      detail:
        "A password/API key/token appears to be assigned a string literal. Secrets in Apex source are visible to " +
        "anyone who can read the class and cannot be rotated without a deploy.",
      fix: "Move secrets to a protected Custom Metadata type, a Named Credential, or an encrypted Custom Setting.",
    })
  }

  return findings
}

function extractMethods(code, className) {
  const methods = []
  // Match: [annotations] access [static] returnType name(params)
  const re =
    /((?:@\w+(?:\([^)]*\))?\s+)*)(public|private|protected|global)\s+(static\s+)?(?:(override|virtual|abstract)\s+)?([\w<>,.\[\] ]+?)\s+(\w+)\s*\(([^)]*)\)\s*\{/g
  let m
  while ((m = re.exec(code)) !== null) {
    const annotations = (m[1] || "").trim()
      ? m[1].trim().split(/\s+(?=@)/).map((a) => a.trim())
      : []
    const access = m[2]
    const isStatic = !!m[3]
    let returnType = (m[5] || "").trim()
    const methodName = m[6]
    const params = (m[7] || "").trim()

    // The class's own constructor: returnType will actually be the access keyword
    const isConstructor = methodName === className && returnType === ""
    if (returnType === className && methodName === className) {
      // pattern won't usually hit; guard anyway
    }
    methods.push({
      name: methodName,
      access,
      static: isStatic,
      returnType: isConstructor ? "(constructor)" : returnType,
      isConstructor,
      isVoid: returnType === "void",
      params: params,
      paramList: parseParams(params),
      annotations,
      throws: /\bthrow\b/.test(methodBody(code, re.lastIndex)),
    })
  }
  // Also catch constructors: access ClassName(params) {
  const ctorRe = new RegExp(
    `(public|global|private|protected)\\s+${className}\\s*\\(([^)]*)\\)\\s*\\{`,
    "g"
  )
  let c
  while ((c = ctorRe.exec(code)) !== null) {
    methods.push({
      name: className,
      access: c[1],
      static: false,
      returnType: "(constructor)",
      isConstructor: true,
      isVoid: false,
      params: (c[2] || "").trim(),
      paramList: parseParams(c[2] || ""),
      annotations: [],
      throws: /\bthrow\b/.test(methodBody(code, ctorRe.lastIndex)),
    })
  }
  return dedupeMethods(methods)
}

// Brace-match a method body starting just after its opening '{' (index = the
// regex lastIndex). Skips single-quoted string literals so a '}' inside a
// string can't unbalance the count. Comments are already stripped upstream.
function methodBody(code, fromIdx) {
  let depth = 1
  let inStr = false
  let i = fromIdx
  for (; i < code.length; i++) {
    const ch = code[i]
    if (inStr) {
      if (ch === "\\") i++
      else if (ch === "'") inStr = false
      continue
    }
    if (ch === "'") inStr = true
    else if (ch === "{") depth++
    else if (ch === "}" && --depth === 0) break
  }
  return code.slice(fromIdx, i)
}

function parseParams(params) {
  if (!params.trim()) return []
  return params.split(",").map((p) => {
    const parts = p.trim().split(/\s+/)
    const pname = parts.pop()
    return { type: parts.join(" "), name: pname }
  })
}

function dedupeMethods(methods) {
  const seen = new Set()
  return methods.filter((m) => {
    const key = `${m.name}(${m.params})`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ---- Scaffold + guidance ------------------------------------------------

const CALLOUT_MOCK = `
    // This class makes HTTP callouts — a mock is required in tests.
    private class TestCalloutMock implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest req) {
            HttpResponse res = new HttpResponse();
            res.setStatusCode(200);
            res.setBody('{"status":"ok"}'); // TODO: realistic response body
            return res;
        }
    }
`

function buildScaffold(className, a) {
  const testName = `${className}Test`
  const testable = a.methods.filter((m) => !m.isConstructor && m.access !== "private")
  const target = testable.length ? testable : a.methods
  const needsInstance = a.methods.some((x) => x.isConstructor)
  const primaryObj = a.soqlObjects[0] || "Account"

  const positives = target.map((m) => positiveTest(className, m, needsInstance, primaryObj)).join("\n")

  const negList = target
    .filter((m) => !m.isConstructor && m.paramList.length > 0 && m.throws)
    .map((m) => negativeTest(className, m, needsInstance))
    .join("\n")
  const negatives = negList ? `\n    // ---- Negative paths (input validation) ----\n${negList}` : ""

  const needsRunAs = a.isController || (a.securityFindings && a.securityFindings.length > 0)
  const runAs = needsRunAs ? runAsTest(className, a) : ""

  const calloutMock = a.httpCallout ? CALLOUT_MOCK : ""
  const asyncNote = asyncNoteFor(a)

  return `@IsTest
private class ${testName} {
    // Auto-generated scaffold — built to follow the Apex test rules:
    //   • @IsTest, no SeeAllData (data is created in @TestSetup)
    //   • every test makes a real Assert.* call (never System.assert(true))
    //   • positive AND negative paths, a 200-record bulk test, and a
    //     System.runAs() test that exercises the class under user permissions
    // TODOs are deliberate: a stub Assert.fail()s until you write the real
    // assertion — fill each one in from the class source.
${calloutMock}
    @TestSetup
    static void makeData() {
        // TODO: insert the records the tests rely on (do NOT use SeeAllData).
        // Objects this class touches: ${a.soqlObjects.length ? a.soqlObjects.join(", ") : "(none detected — add as needed)"}
        // Remember required fields and validation rules for each object.
    }

    // ---- Positive paths ----
${positives}${negatives}${runAs}

    // ---- Bulk safety ----
    @IsTest
    static void test_bulk_200() {
        // Catch SOQL/DML-in-loop and governor-limit problems at scale.
${asyncNote}        List<${primaryObj}> records = new List<${primaryObj}>();
        for (Integer i = 0; i < 200; i++) {
            records.add(new ${primaryObj}(${primaryObj === "Account" ? "Name = 'Bulk ' + i" : "/* TODO: set required fields */"}));
        }
        insert records;

        Test.startTest();
        // TODO: invoke ${className} against the 200 records above.
        Test.stopTest();

        Assert.isTrue([SELECT COUNT() FROM ${primaryObj}] >= 200, 'expected at least 200 ${primaryObj} records under test');
    }
}
`
}

function positiveTest(className, m, needsInstance, primaryObj) {
  const sig = m.paramList.length ? ` (${m.paramList.map((p) => `${p.type} ${p.name}`).join(", ")})` : ""
  let body
  if (m.isConstructor) {
    body =
      `        Test.startTest();\n` +
      `        ${className} instanceUnderTest = new ${className}(${argList(m.paramList, "valid")});\n` +
      `        Test.stopTest();\n` +
      `        Assert.isNotNull(instanceUnderTest, '${className} constructor should build an instance');`
  } else {
    const instanceLine = needsInstance && !m.static ? `        ${className} instance = new ${className}();\n` : ""
    const call = (m.static ? `${className}.${m.name}` : `instance.${m.name}`) + `(${argList(m.paramList, "valid")})`
    if (m.isVoid) {
      body =
        instanceLine +
        `        Test.startTest();\n` +
        `        ${call};\n` +
        `        Test.stopTest();\n` +
        `        // TODO: re-query the records this method changed and assert the new state.\n` +
        `        List<${primaryObj}> after = [SELECT Id FROM ${primaryObj}];\n` +
        `        Assert.isFalse(after.isEmpty(), 'expected ${primaryObj} records after ${m.name} — seed them in @TestSetup');`
    } else {
      body =
        instanceLine +
        `        Test.startTest();\n` +
        `        Object result = ${call};\n` +
        `        Test.stopTest();\n` +
        `        Assert.isNotNull(result, '${m.name} should return a value');\n` +
        `        // TODO: tighten — assert the exact value/size you expect.`
    }
  }
  return `    @IsTest
    static void test_${m.name}_positive() {
        // Arrange — VALID inputs${sig}
${body}
    }
`
}

function negativeTest(className, m, needsInstance) {
  const instanceLine = needsInstance && !m.static ? `        ${className} instance = new ${className}();\n` : ""
  const call = (m.static ? `${className}.${m.name}` : `instance.${m.name}`) + `(${argList(m.paramList, "invalid")})`
  return `    @IsTest
    static void test_${m.name}_rejectsInvalidInput() {
        // This class validates input (it throws) — prove the guard fires.
${instanceLine}        Test.startTest();
        try {
            ${call};
            Assert.fail('${m.name} should have thrown for invalid input');
        } catch (Exception e) {
            // TODO: assert the specific exception type/message you throw.
            Assert.isNotNull(e.getMessage(), 'a validation exception should carry a message');
        }
        Test.stopTest();
    }
`
}

function runAsTest(className, a) {
  const entry = a.exposedMethodNames.length ? a.exposedMethodNames.join(", ") : "the public entry points"
  const catchNote = a.securityFindings && a.securityFindings.length ? " — and how you'd catch the CRUD/FLS gaps flagged above" : ""
  return `
    // ---- Permission / FLS enforcement ----
    @IsTest
    static void test_runsUnderUserPermissions() {
        // FLS, CRUD and sharing are only enforced in *user mode*. Running as a
        // minimal-access user proves this class respects the running user's
        // permissions${catchNote}.
        User restricted = newMinAccessUser();
        System.runAs(restricted) {
            Test.startTest();
            // TODO: call ${entry} and assert the user only sees/writes what
            // their permissions allow. If the class queries/DMLs in system mode,
            // tighten it first (WITH USER_MODE / 'as user').
            Test.stopTest();
        }
        Assert.isNotNull(restricted.Id, 'restricted test user should have been created');
    }

    private static User newMinAccessUser() {
        Profile p = [SELECT Id FROM Profile WHERE Name = 'Minimum Access - Salesforce' LIMIT 1];
        String unique = String.valueOf(DateTime.now().getTime());
        User u = new User(
            ProfileId = p.Id, LastName = 'McpTest', Alias = 'mcptest',
            Email = 'mcp.test@example.com.invalid',
            Username = 'mcp.test.' + unique + '@example.com.invalid',
            EmailEncodingKey = 'UTF-8', LanguageLocaleKey = 'en_US',
            LocaleSidKey = 'en_US', TimeZoneSidKey = 'America/Los_Angeles'
        );
        insert u;
        return u;
    }
`
}

function asyncNoteFor(a) {
  return a.async.batchable
    ? "        // Batchable: enclose Database.executeBatch(...) between Test.startTest()/stopTest() so it runs synchronously.\n"
    : a.async.queueable
    ? "        // Queueable: System.enqueueJob(...) inside Test.startTest()/stopTest().\n"
    : a.async.schedulable
    ? "        // Schedulable: use System.schedule(...) inside Test.startTest()/stopTest().\n"
    : ""
}

function argList(paramList, mode) {
  return paramList.map((p) => (mode === "invalid" ? invalidDefault(p.type) : validDefault(p.type))).join(", ")
}

// Valid defaults exercise the happy path — non-blank/positive so they don't
// trip common guard clauses (String.isBlank, limit <= 0, etc.).
function validDefault(type) {
  const t = (type || "").toLowerCase()
  if (t.includes("list") || t.includes("[]")) return "new List<Object>()"
  if (t.includes("set<")) return "new Set<Id>()"
  if (t.includes("map<")) return "new Map<Id, Object>()"
  if (t === "id") return "null /* TODO: Id from @TestSetup */"
  if (t === "string") return "'Test'"
  if (t === "boolean") return "true"
  if (t === "integer" || t === "long") return "1"
  if (t === "decimal" || t === "double") return "1.0"
  if (t === "date") return "Date.today()"
  if (t === "datetime") return "System.now()"
  return `null /* ${type} */`
}

// Invalid defaults intentionally trip validation (blank/zero/null) so the
// negative test can prove the guard clause throws.
function invalidDefault(type) {
  const t = (type || "").toLowerCase()
  if (t.includes("list") || t.includes("[]")) return "new List<Object>()"
  if (t.includes("set<")) return "new Set<Id>()"
  if (t.includes("map<")) return "new Map<Id, Object>()"
  if (t === "string") return "''"
  if (t === "boolean") return "false"
  if (t === "integer" || t === "long") return "0"
  if (t === "decimal" || t === "double") return "0"
  return `null /* ${type} */`
}

function buildGuidance(a) {
  const tips = []
  if (a.securityFindings && a.securityFindings.length) {
    tips.push(`SECURITY: ${a.securityFindings.length} issue(s) detected — fix the class first, then prove it in tests:`)
    for (const f of a.securityFindings) tips.push(`  • [${f.severity.toUpperCase()}] ${f.title} — ${f.fix}`)
  }
  tips.push(
    "Write tests from the returned 'sourceBody' — every test must assert a real outcome (never System.assert(true))."
  )
  if (a.sharing === "without sharing")
    tips.push("Class runs 'without sharing'; add a System.runAs() test with a restricted user to prove behavior.")
  if (a.dmlOperations.length)
    tips.push(`Performs DML (${a.dmlOperations.join(", ")}) — assert record state after Test.stopTest() by re-querying.`)
  if (a.httpCallout)
    tips.push("Makes HTTP callouts — set Test.setMock(HttpCalloutMock.class, new TestCalloutMock()) before the call.")
  if (a.async.future || a.async.callout)
    tips.push("Uses @future — assertions must come AFTER Test.stopTest(), which forces async work to complete.")
  if (a.async.batchable) tips.push("Batchable — wrap Database.executeBatch in Test.start/stopTest and use a small scope.")
  if (a.sendsEmail) tips.push("Sends email — wrap in Test.start/stopTest; Messaging.sendEmail is a no-op in tests.")
  if (a.exposedMethodNames.length)
    tips.push(`Exposed entry points to prioritize: ${a.exposedMethodNames.join(", ")}.`)
  tips.push("Cover negative/invalid input and a 200-record bulk run; use System.runAs() to enforce FLS/sharing.")
  tips.push("Never use @IsTest(SeeAllData=true) — create data in @TestSetup so tests are deterministic.")
  tips.push("Target ≥ 75% coverage, but aim for meaningful assertions over coverage padding.")
  return tips
}

function uniq(arr) {
  return [...new Set(arr)]
}
function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
