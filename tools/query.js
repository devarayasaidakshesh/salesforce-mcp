import { runSF, capRecords, cleanRecords, FriendlyError } from "../utils/sf.js"

const DEFAULT_MAX_RECORDS = 200

export const queryTools = [
  {
    name: "soql_query",
    description:
      "Run a SOQL query against your connected Salesforce org and return the results. " +
      "Quotes and special characters in the query are handled safely.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The SOQL query to execute. Example: SELECT Id, Name FROM Account WHERE Name = 'Acme' LIMIT 10",
        },
        target_org: {
          type: "string",
          description: "Optional: alias of the org to query. Uses the default org if not provided.",
        },
        max_records: {
          type: "number",
          description: `Optional: max records returned to the model (default ${DEFAULT_MAX_RECORDS}). Prevents large results from flooding context.`,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "soql_query_all",
    description: "Run a SOQL query including deleted and archived records (queryAll)",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The SOQL query to execute against all records including deleted ones" },
        target_org: { type: "string", description: "Optional: alias of the org to query" },
        max_records: { type: "number", description: `Optional: max records returned (default ${DEFAULT_MAX_RECORDS})` },
      },
      required: ["query"],
    },
  },
]

function validateQuery(query) {
  if (!query || typeof query !== "string" || query.trim() === "") {
    throw new FriendlyError("A non-empty 'query' string is required.")
  }
  const trimmed = query.trim()
  if (!/^select\s/i.test(trimmed)) {
    throw new FriendlyError(
      "Only SELECT queries are allowed here. To modify data, use a dedicated DML tool — " +
        "this keeps the query tool read-only and safe."
    )
  }
  return trimmed
}

function orgArgs(target_org) {
  return target_org ? ["--target-org", String(target_org)] : []
}

export async function handleQuery(toolName, args) {
  const query = validateQuery(args.query)
  const max = args.max_records || DEFAULT_MAX_RECORDS

  if (toolName === "soql_query" || toolName === "soql_query_all") {
    const cmd = ["data", "query", "--query", query, ...orgArgs(args.target_org)]
    if (toolName === "soql_query_all") cmd.push("--all-rows")

    const result = await runSF(cmd)
    const all = cleanRecords(result.records || [])
    const { records, truncated, originalCount } = capRecords(all, max)

    return {
      totalSize: result.totalSize ?? originalCount,
      returnedCount: records.length,
      truncated,
      ...(truncated && {
        note: `Showing first ${records.length} of ${result.totalSize ?? originalCount} records. Add a tighter WHERE/LIMIT or raise max_records to see more.`,
      }),
      includesDeleted: toolName === "soql_query_all",
      records,
    }
  }
}
