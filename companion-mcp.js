const http = require('http');
const { exec } = require('child_process');

const PORT = 3920; 

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
    res.end(JSON.stringify({ status: 'ok' }));
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
            result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'local-shell-mcp', version: '1.0.0' } }
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
                  description: 'Execute a terminal command locally on the host machine (e.g. running git, copilot, agy, or claude CLI).',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      command: { type: 'string', description: 'The exact terminal command to execute.' }
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
            console.log(`[MCP] Executing: ${command}`);
            
            // Execute command locally
            exec(command, (error, stdout, stderr) => {
              const output = stdout + stderr;
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                jsonrpc: '2.0',
                id,
                result: {
                  content: [{ type: 'text', text: output }],
                  isError: !!error
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
  console.log(`🚀 Local Shell MCP Server running on http://localhost:${PORT}/mcp`);
  console.log(`Add this URL under Config -> MCP Servers inside Magpie!`);
});
