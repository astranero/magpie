const http = require('http');
const { spawn } = require('child_process');

const PORT = 3920;

// v1.1 — chat-safe command execution:
//  * stdout and stderr are returned SEPARATELY. The old `stdout + stderr`
//    concatenation glued CLI warnings ("Warning: no stdin data received in
//    3s…") onto the end of chat answers.
//  * `stdin` argument: the extension pipes the full composed prompt (system
//    instructions + sources + history) over stdin instead of interpolating
//    untrusted page content into a shell string. stdin is ALWAYS closed, so
//    interactive CLIs never sit waiting on the 3-second stdin probe.
//  * `timeoutMs` argument (default 5 min) + output cap so a hung CLI can't
//    wedge the server.
const CAPABILITIES = { stdin: true, version: '1.1.0' };
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

function runCommand(command, stdinData, timeoutMs, cb) {
  // A shell parses the command (users configure full command lines with flags),
  // but untrusted content arrives via `stdinData`, never inside `command`.
  const child = spawn(command, {
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: Math.min(Math.max(timeoutMs || 300_000, 1000), 600_000)
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { if (stdout.length < MAX_OUTPUT_BYTES) stdout += d; });
  child.stderr.on('data', d => { if (stderr.length < MAX_OUTPUT_BYTES) stderr += d; });
  child.on('error', err => cb(err, stdout, stderr, -1));
  child.on('close', code => cb(null, stdout, stderr, code ?? -1));

  // EPIPE guard: a child that exits before draining stdin (e.g. `which` probe,
  // a CLI that errors out instantly) makes the write emit 'error' on the stdin
  // stream — unhandled, that is an uncaughtException that kills the whole
  // server. The 'error' handler on the ChildProcess above does NOT cover it.
  child.stdin.on('error', () => {});

  // Close stdin even when there's nothing to write — an open pipe makes CLIs
  // wait for piped input (the source of the "no stdin data received" warning).
  if (stdinData) child.stdin.write(stdinData);
  child.stdin.end();
}

const server = http.createServer((req, res) => {
  // Allow the browser extension to connect from chrome-extension://
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', capabilities: CAPABILITIES }));
    return;
  }

  if (req.method === 'POST' && (req.url === '/mcp' || req.url === '/')) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { method, params, id } = payload;

        if (method === 'initialize') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'local-shell-mcp', version: CAPABILITIES.version } }
          }));
          return;
        }

        if (method === 'tools/list') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              tools: [
                {
                  name: 'execute_command',
                  description: 'Execute a terminal command locally on the host machine (e.g. running git, copilot, agy, or claude CLI). Optional stdin is piped to the process; stdin is always closed.',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      command: { type: 'string', description: 'The exact terminal command to execute.' },
                      stdin: { type: 'string', description: 'Optional data piped to the process over stdin.' },
                      timeoutMs: { type: 'number', description: 'Kill the process after this many ms (default 300000, max 600000).' }
                    },
                    required: ['command']
                  }
                }
              ]
            }
          }));
          return;
        }

        if (method === 'tools/call') {
          const { name, arguments: args } = params || {};
          if (name === 'execute_command') {
            const command = args.command;
            console.log(`[MCP] Executing: ${command}${args.stdin ? ` (stdin: ${args.stdin.length} chars)` : ''}`);

            runCommand(command, args.stdin, args.timeoutMs, (error, stdout, stderr, code) => {
              const failed = !!error || code !== 0;
              // The ANSWER is stdout. stderr rides along as structured metadata
              // (surfaced only when the command failed and stdout is empty) —
              // never concatenated into the reply text.
              const text = stdout.trim() || (failed ? stderr.trim() : '');
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                jsonrpc: '2.0',
                id,
                result: {
                  content: [{ type: 'text', text }],
                  isError: failed,
                  _meta: { exitCode: code, stderr: stderr.slice(0, 4000) }
                }
              }));
            });
            return;
          }
        }

        res.writeHead(404);
        res.end();
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`🚀 Local Shell MCP Server v${CAPABILITIES.version} running on http://localhost:${PORT}/mcp`);
  console.log(`Add this URL under Config -> MCP Servers inside Magpie!`);
});
