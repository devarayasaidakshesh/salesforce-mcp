// Drives the real MCP tool handlers against a LIVE org.
// Usage: node test/live.mjs <toolName> '<jsonArgs>'
import { handleQuery } from "../tools/query.js"
import { handleSchema } from "../tools/schema.js"
import { handleApex } from "../tools/apex.js"
import { handleOrg } from "../tools/org.js"
import { handleTestgen } from "../tools/testgen.js"
import { handlePackage } from "../tools/packagexml.js"

const routes = [
  [["soql_query", "soql_query_all"], handleQuery],
  [["describe_object", "list_objects", "find_field"], handleSchema],
  [["run_apex", "get_apex_class", "list_apex_classes"], handleApex],
  [["org_info", "org_limits", "list_orgs", "current_user"], handleOrg],
  [["analyze_apex_class", "check_coverage", "list_untested_classes"], handleTestgen],
  [["build_package_xml", "list_metadata_components"], handlePackage],
]

const tool = process.argv[2]
const args = process.argv[3] ? JSON.parse(process.argv[3]) : {}
const route = routes.find(([names]) => names.includes(tool))
if (!route) {
  console.error("Unknown tool:", tool)
  process.exit(1)
}

try {
  const result = await route[1](tool, args)
  console.log(JSON.stringify(result, null, 2))
} catch (e) {
  console.error("ERROR:", e.message)
  process.exit(1)
}
