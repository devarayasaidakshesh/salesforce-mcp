// Boots the real MCP server over stdio using the SDK client and lists tools.
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const transport = new StdioClientTransport({
  command: "node",
  args: [join(__dirname, "..", "index.js")],
})

const client = new Client({ name: "boot-test", version: "1.0.0" }, { capabilities: {} })
await client.connect(transport)
const { tools } = await client.listTools()
console.log("Server booted. Tools registered:", tools.length)
for (const t of tools) console.log("  -", t.name)
await client.close()
process.exit(tools.length === 17 ? 0 : 1)
