// A local MCP transport for the installed CLI smoke test. The production connector is exercised separately.
import { createInterface } from 'node:readline';

const name = 'Acceptance Factory';
const factory = 'acceptance';
const workflow = { name: 'Delivery', workflow: 'wf1' };
const tools = [
  { name: 'list_factories', description: 'List available factories.', inputSchema: { type: 'object', properties: {} } },
  { name: 'factory_board', description: 'Read a workflow board.', inputSchema: { type: 'object', properties: {
    factory: { type: 'string' }, workflow: { type: 'string' }, backlog_offset: { type: 'integer' },
  }, required: ['factory'] } },
];

function readTool({ name: tool, arguments: args }) {
  if (tool === 'list_factories') {
    return { factories: [{ factory, name, workspace: { name: 'Engineering' } }] };
  }
  if (tool === 'factory_board' && args.factory === factory && args.workflow === workflow.workflow && args.backlog_offset === 15) {
    return { name, factory, workflow, backlog_count: 16, backlog: { offset: 15, next_offset: null,
      stories: [{ reference: '#16', title: 'Verify release evidence', story: 'story16' }] } };
  }
  throw new Error('Unexpected factory request');
}

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id == null) continue;
  let result;
  if (method === 'initialize') {
    result = { protocolVersion: params.protocolVersion, serverInfo: { name: 'native-factory-test', version: '1' }, capabilities: { tools: {} } };
  } else if (method === 'tools/list') {
    result = { tools };
  } else if (method === 'tools/call') {
    const data = readTool(params);
    result = { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }) + '\n');
    continue;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
