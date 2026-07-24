# MCP Integration

`lib/mcp-client.ts` — Model Context Protocol client over the **Streamable
HTTP transport only**. MV3 extensions cannot spawn processes or open raw TCP
sockets, so stdio MCP servers are unreachable by design; the user runs the
server themselves and registers its HTTP endpoint.

## Configuration (Config → MCP Servers)

`McpServerConfig { id, name, url, enabled, authToken?, setupHint?, healthUrl? }`,
persisted under `mcpServers` in `chrome.storage.local`. The `url` is validated by
`isAllowedMcpUrl` — `https://` to any host, `http://` only to loopback
(`localhost`/`127.0.0.1`/`[::1]`). Optional token is sent as
`Authorization: Bearer …` on every request including the initialize
handshake. **Enabling a server is the permission grant** — research may then
call its tools. A "Test" button connects and lists the server's tools.

## Protocol

Single POST endpoint, JSON-RPC 2.0. `McpConnection` handles:
- `initialize` (+ `notifications/initialized`), echoing `Mcp-Session-Id`
  when the server issues one,
- `tools/list`, `tools/call`,
- responses in plain JSON **or** SSE frames (`parseRpcResponse` takes the
  last `data:` frame carrying a result/error),
- 30 s per-RPC timeout.

`callTool` concatenates `text`-type content blocks; `isError` results throw.

## Research usage

During deep research stage 1, an MCP agent runs alongside WEB/ACADEMIC/NEWS:
for each enabled server, tools whose name/description look search-like
(`search|query|lookup|retrieve|find|fetch`) receive the topic (argument key
guessed from the input schema: `query`/`q`/`topic`/…, capped 2 tools per
server). Results pass the standard content quality gate, are indexed as
`MCP`-labeled sources, and participate in source balancing + citations.
Servers with nothing to contribute drop out silently (no empty-agent
warning when no MCP is configured).
