import { runSF, FriendlyError, cleanRecords } from "../utils/sf.js"

export const testgenTools = [
  {
    name: "analyze_apex_class",
    description:
      "Deep-analyze an Apex class from the org for test planning: methods + signatures, DML operations, " +
      "SOQL objects, HTTP callouts, async patterns (Batch/Queueable/Schedulable/Future), and sharing model. " +
      "Returns structured context plus a test scaffold. Use this, then write real assertions from the returned source.",
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
  }
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
    })
  }
  return dedupeMethods(methods)
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

function buildScaffold(className, a) {
  const testName = `${className}Test`
  const testable = a.methods.filter((m) => !m.isConstructor && m.access !== "private")
  const target = testable.length ? testable : a.methods

  const methodBlocks = target
    .map((m) => {
      const call =
        m.static && !m.isConstructor
          ? `${className}.${m.name}(${placeholderArgs(m.paramList)})`
          : m.isConstructor
          ? `new ${className}(${placeholderArgs(m.paramList)})`
          : `instance.${m.name}(${placeholderArgs(m.paramList)})`
      const capture = m.isVoid || m.isConstructor ? "" : "Object result = "
      return `
    @IsTest
    static void test_${m.name}_positive() {
        // Arrange: build the inputs ${m.name} expects${m.paramList.length ? ` (${m.paramList.map((p) => `${p.type} ${p.name}`).join(", ")})` : ""}
        ${a.methods.some((x) => x.isConstructor) && !m.static && !m.isConstructor ? `${className} instance = new ${className}();` : ""}
        Test.startTest();
        ${capture}${call};
        Test.stopTest();
        // Assert: TODO replace with a REAL assertion about ${m.isVoid ? "the records/state changed" : "the returned value"}
        System.assert(true, 'TODO: assert real outcome of ${m.name}');
    }`
    })
    .join("\n")

  const calloutMock = a.httpCallout
    ? `
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
    : ""

  const asyncNote = a.async.batchable
    ? "        // Batchable: enclose Database.executeBatch(...) between Test.startTest()/stopTest() so it runs synchronously.\n"
    : a.async.queueable
    ? "        // Queueable: System.enqueueJob(...) inside Test.startTest()/stopTest().\n"
    : a.async.schedulable
    ? "        // Schedulable: use System.schedule(...) inside Test.startTest()/stopTest().\n"
    : ""

  return `@IsTest
private class ${testName} {
${calloutMock}
    @TestSetup
    static void makeData() {
        // TODO: create shared records used by tests.
        // Objects this class touches: ${a.soqlObjects.length ? a.soqlObjects.join(", ") : "(none detected — add as needed)"}
        // Remember required fields and validation rules for each object.
    }
${methodBlocks}

    @IsTest
    static void test_bulk() {
        // Bulk-safety: exercise the logic with 200 records to catch governor-limit issues.
${asyncNote}        Test.startTest();
        // TODO: invoke ${className} against 200 records
        Test.stopTest();
        System.assert(true, 'TODO: assert bulk outcome');
    }
}
`
}

function placeholderArgs(paramList) {
  return paramList.map((p) => defaultForType(p.type)).join(", ")
}

function defaultForType(type) {
  const t = (type || "").toLowerCase()
  if (t.includes("list") || t.includes("[]")) return "new List<Object>()"
  if (t.includes("set<")) return "new Set<Id>()"
  if (t.includes("map<")) return "new Map<Id, Object>()"
  if (t === "id") return "null /* Id */"
  if (t === "string") return "''"
  if (t === "boolean") return "false"
  if (t === "integer" || t === "long") return "0"
  if (t === "decimal" || t === "double") return "0.0"
  if (t === "date") return "Date.today()"
  if (t === "datetime") return "System.now()"
  return `null /* ${type} */`
}

function buildGuidance(a) {
  const tips = []
  tips.push(
    "Write tests from the returned 'sourceBody' — assert real outcomes, do not leave the TODO assertions."
  )
  if (a.sharing === "without sharing")
    tips.push("Class runs 'without sharing'; consider a System.runAs() test with a restricted user to prove behavior.")
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
