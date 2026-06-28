import { execFile } from "child_process"
import { promisify } from "util"

const execFileAsync = promisify(execFile)

// The sf binary. Overridable for testing with a mock CLI.
const SF_BIN = process.env.SF_MCP_BIN || "sf"
const DEFAULT_TIMEOUT_MS = Number(process.env.SF_MCP_TIMEOUT_MS) || 120000
const MAX_BUFFER = 30 * 1024 * 1024 // 30MB

// A friendly, user-facing error. Its message is safe to show directly.
export class FriendlyError extends Error {
  constructor(message) {
    super(message)
    this.name = "FriendlyError"
    this.friendly = true
  }
}

/**
 * Run a Salesforce CLI command.
 *
 * @param {string[]} args  Command + flags as an ARRAY (never a shell string).
 *                         Example: ["data", "query", "--query", "SELECT Id FROM Account"]
 *                         Values are passed as exec arguments, so quotes, spaces and
 *                         special characters in SOQL are handled safely — no shell parsing.
 * @param {object}  opts   { timeout }
 * @returns {Promise<any>} The `.result` field of the CLI's JSON response.
 */
export async function runSF(args, opts = {}) {
  const fullArgs = [...args, "--json"]
  let stdout

  try {
    const res = await execFileAsync(SF_BIN, fullArgs, {
      maxBuffer: MAX_BUFFER,
      timeout: opts.timeout || DEFAULT_TIMEOUT_MS,
    })
    stdout = res.stdout
  } catch (err) {
    // CLI not installed / not on PATH
    if (err.code === "ENOENT") {
      throw new FriendlyError(
        "Salesforce CLI ('sf') was not found on your system.\n" +
          "Install it with:  npm install -g @salesforce/cli\n" +
          "Then authenticate:  sf org login web --alias myorg"
      )
    }
    // Timed out — execFile sends SIGTERM
    if (err.killed || err.signal === "SIGTERM") {
      throw new FriendlyError(
        `The Salesforce command timed out after ${
          (opts.timeout || DEFAULT_TIMEOUT_MS) / 1000
        }s. ` +
          "This often means a query is missing a LIMIT clause or the org is slow to respond. " +
          "Try narrowing the query or adding 'LIMIT 200'."
      )
    }
    // Output too large for the buffer
    if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new FriendlyError(
        "The result was too large to return. Add a LIMIT clause or select fewer fields, " +
          "and avoid selecting large text fields (like Apex Body) across many records."
      )
    }
    // sf exits non-zero on a handled error but still prints JSON to stdout.
    if (err.stdout) {
      stdout = err.stdout
    } else {
      throw mapError(err.message || String(err))
    }
  }

  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    // Non-JSON output usually means the command doesn't support --json,
    // or the CLI printed a warning/update notice ahead of the JSON.
    const recovered = recoverJson(stdout)
    if (recovered) {
      parsed = recovered
    } else {
      throw new FriendlyError(
        "Could not understand the Salesforce CLI response. " +
          "Make sure your CLI is up to date:  npm update -g @salesforce/cli"
      )
    }
  }

  // sf uses status !== 0 for errors (and sometimes the field `code`).
  if (parsed.status !== undefined && parsed.status !== 0) {
    throw mapError(parsed.message || parsed.name || "Salesforce CLI error", parsed)
  }

  // `.result` holds the payload. Some commands return the data at top level.
  return parsed.result !== undefined ? parsed.result : parsed
}

// Some CLI versions print a banner / update notice before the JSON body.
// Try to recover the JSON object embedded in mixed output.
function recoverJson(text) {
  if (!text) return null
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

// Translate raw CLI errors into actionable, human-readable guidance.
function mapError(message, parsed) {
  const m = (message || "").toString()
  const name = (parsed && parsed.name) || ""
  const lower = (m + " " + name).toLowerCase()

  if (
    lower.includes("no default environment") ||
    lower.includes("nodefaultenv") ||
    lower.includes("requiresusername") ||
    lower.includes("no default org") ||
    lower.includes("no org configuration") ||
    lower.includes("notargetorg")
  ) {
    return new FriendlyError(
      "No Salesforce org is connected.\n" +
        "Log in first:  sf org login web --alias myorg\n" +
        "Or pass an existing alias via the 'target_org' parameter. " +
        "See your orgs with the 'list_orgs' tool."
    )
  }

  if (
    lower.includes("invalid_session_id") ||
    lower.includes("session expired") ||
    lower.includes("expired access/refresh token") ||
    lower.includes("invalidgrant")
  ) {
    return new FriendlyError(
      "Your org session has expired. Re-authenticate with:\n" +
        "  sf org login web --alias myorg"
    )
  }

  if (
    lower.includes("invalid_type") ||
    lower.includes("sobject type") ||
    lower.includes("invalid field") ||
    lower.includes("no such column")
  ) {
    return new FriendlyError(
      `Salesforce rejected the request: ${m}\n` +
        "Check the object/field API names. The 'describe_object' and 'list_objects' tools " +
        "can confirm exact API names (custom fields end in '__c')."
    )
  }

  if (lower.includes("malformed_query") || lower.includes("unexpected token")) {
    return new FriendlyError(`Your SOQL has a syntax error: ${m}`)
  }

  if (lower.includes("insufficient access") || lower.includes("insufficient_access")) {
    return new FriendlyError(
      "The connected user doesn't have permission for this operation. " +
        "Check the user's profile / permission sets."
    )
  }

  // Fall back to the raw message, but keep it friendly-typed so callers
  // don't accidentally leak a stack trace.
  return new FriendlyError(m)
}

/**
 * Cap an array of records so a huge result never floods the model's context.
 * Returns { records, truncated, originalCount }.
 */
export function capRecords(records, max) {
  const limit = max || 200
  if (!Array.isArray(records)) return { records: records, truncated: false, originalCount: 0 }
  if (records.length <= limit) {
    return { records, truncated: false, originalCount: records.length }
  }
  return {
    records: records.slice(0, limit),
    truncated: true,
    originalCount: records.length,
  }
}

// Strip Salesforce's `attributes` metadata noise from query records,
// which adds a type/url to every row and wastes context.
export function cleanRecords(records) {
  if (!Array.isArray(records)) return records
  return records.map((r) => {
    if (r && typeof r === "object" && "attributes" in r) {
      const { attributes, ...rest } = r
      return rest
    }
    return r
  })
}
