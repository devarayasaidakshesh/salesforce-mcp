import { execFile } from "child_process"
import { promisify } from "util"
import { writeFile, unlink, mkdtemp } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { runSF, FriendlyError, capRecords, cleanRecords } from "../utils/sf.js"

const execFileAsync = promisify(execFile)
const SF_BIN = process.env.SF_MCP_BIN || "sf"

export const apexTools = [
  {
    name: "run_apex",
    description: "Execute anonymous Apex code in your org and return the output, debug logs, and compile status",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "The Apex code to execute. Example: System.debug('Hello');" },
        target_org: { type: "string", description: "Optional: alias of the org to run the code in" },
      },
      required: ["code"],
    },
  },
  {
    name: "get_apex_class",
    description: "Retrieve the source code of an Apex class from your org",
    inputSchema: {
      type: "object",
      properties: {
        class_name: { type: "string", description: "API name of the Apex class" },
        target_org: { type: "string", description: "Optional: alias of the org to query" },
      },
      required: ["class_name"],
    },
  },
  {
    name: "list_apex_classes",
    description: "List Apex classes in the org (name, status, last modified). Does NOT include bodies, so it stays compact.",
    inputSchema: {
      type: "object",
      properties: {
        target_org: { type: "string", description: "Optional: alias of the org to query" },
        filter: { type: "string", description: "Optional: case-insensitive substring filter on class name" },
      },
    },
  },
]

function orgArgs(target_org) {
  return target_org ? ["--target-org", String(target_org)] : []
}

function validateClassName(name) {
  if (!name || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    throw new FriendlyError(`'${name}' is not a valid Apex class name (letters, numbers, underscores only).`)
  }
  return name
}

export async function handleApex(toolName, args) {
  if (toolName === "run_apex") {
    if (!args.code || !args.code.trim()) throw new FriendlyError("'code' is required and cannot be empty.")

    // Write to a private temp DIR we create ourselves, so we control permissions
    // and get a clear error if the environment blocks temp writes.
    let dir
    let file
    try {
      dir = await mkdtemp(join(tmpdir(), "sfmcp-"))
      file = join(dir, "anon.apex")
      await writeFile(file, args.code, "utf8")
    } catch (e) {
      throw new FriendlyError(
        "Could not write a temporary file to run Apex (the environment may restrict temp writes). " +
          `Underlying error: ${e.message}`
      )
    }

    try {
      const fullArgs = ["apex", "run", "--file", file, ...orgArgs(args.target_org), "--json"]
      let stdout
      try {
        const res = await execFileAsync(SF_BIN, fullArgs, { maxBuffer: 10 * 1024 * 1024 })
        stdout = res.stdout
      } catch (err) {
        if (err.code === "ENOENT")
          throw new FriendlyError("Salesforce CLI ('sf') not found. Install: npm install -g @salesforce/cli")
        if (!err.stdout) throw new FriendlyError(err.message)
        stdout = err.stdout
      }
      const parsed = JSON.parse(stdout)

      // On a compile failure the CLI returns status != 0 with NO `result` —
      // the detail lives at the top level (name/message/data). Surface it
      // instead of returning a uselessly-null object.
      if (parsed.status !== undefined && parsed.status !== 0 && !parsed.result) {
        const data = parsed.data || {}
        const isCompile = (parsed.name || "").toLowerCase().includes("compile")
        return {
          success: false,
          compiled: isCompile ? false : (data.compiled ?? false),
          compileProblem: isCompile ? parsed.message : data.compileProblem || null,
          exceptionMessage: isCompile ? null : parsed.message,
          line: data.line ?? undefined,
          column: data.column ?? undefined,
          logs: data.logs || "",
        }
      }

      const result = parsed.result || {}
      return {
        success: result.success ?? false,
        compiled: result.compiled ?? false,
        compileProblem: result.compileProblem || null,
        exceptionMessage: result.exceptionMessage || null,
        exceptionStackTrace: result.exceptionStackTrace || null,
        line: result.line >= 0 ? result.line : undefined,
        logs: result.logs || "",
      }
    } finally {
      // Best-effort cleanup; never let cleanup failure mask the real result.
      try { await unlink(file) } catch {}
    }
  }

  if (toolName === "get_apex_class") {
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
    if (!rec.Body || rec.Body.trim() === "(hidden)") {
      throw new FriendlyError(
        `'${name}' is a managed-package class; its source code is hidden by the package and cannot be retrieved.`
      )
    }
    return { name: rec.Name, id: rec.Id, apiVersion: rec.ApiVersion, body: rec.Body }
  }

  if (toolName === "list_apex_classes") {
    let where = ""
    if (args.filter) {
      const safe = String(args.filter).replace(/'/g, "\\'")
      where = ` WHERE Name LIKE '%${safe}%'`
    }
    const r = await runSF([
      "data",
      "query",
      "--query",
      `SELECT Id, Name, Status, LastModifiedDate FROM ApexClass${where} ORDER BY Name`,
      ...orgArgs(args.target_org),
    ])
    const all = cleanRecords(r.records || [])
    const { records, truncated, originalCount } = capRecords(all, 300)
    return {
      count: originalCount,
      truncated,
      classes: records.map((c) => ({
        name: c.Name,
        id: c.Id,
        status: c.Status,
        lastModified: c.LastModifiedDate,
      })),
    }
  }
}
