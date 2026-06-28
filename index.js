import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"

import { queryTools, handleQuery } from "./tools/query.js"
import { schemaTools, handleSchema } from "./tools/schema.js"
import { apexTools, handleApex } from "./tools/apex.js"
import { orgTools, handleOrg } from "./tools/org.js"
import { testgenTools, handleTestgen } from "./tools/testgen.js"
import { packageTools, handlePackage } from "./tools/packagexml.js"

const server = new Server(
  { name: "salesforce-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
)

const allTools = [
  ...queryTools,
  ...schemaTools,
  ...apexTools,
  ...orgTools,
  ...testgenTools,
  ...packageTools,
]

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: allTools }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    let result

    if (queryTools.find((t) => t.name === name)) {
      result = await handleQuery(name, args)
    } else if (schemaTools.find((t) => t.name === name)) {
      result = await handleSchema(name, args)
    } else if (apexTools.find((t) => t.name === name)) {
      result = await handleApex(name, args)
    } else if (orgTools.find((t) => t.name === name)) {
      result = await handleOrg(name, args)
    } else if (testgenTools.find((t) => t.name === name)) {
      result = await handleTestgen(name, args)
    } else if (packageTools.find((t) => t.name === name)) {
      result = await handlePackage(name, args)
    } else {
      throw new Error(`Unknown tool: ${name}`)
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    }
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${err.message}`,
        },
      ],
      isError: true,
    }
  }
})

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error("Salesforce MCP server running...")
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
