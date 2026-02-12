export type ScenarioStep = { server: string; tool: string; args: Record<string, unknown> };

export type Scenario = {
  id: string;
  name: string;
  vanillaSteps: ScenarioStep[];
  whitenoiseCode: string;
};

const SCENARIOS: Scenario[] = [
  {
    id: 'single',
    name: 'Single tool call',
    vanillaSteps: [{ server: 'everything', tool: 'echo', args: { message: 'hello' } }],
    whitenoiseCode: `
import { echo } from 'mcp/servers/everything/echo';
const out = await echo({ message: 'hello' });
console.log(JSON.stringify(out));
`,
  },
  {
    id: 'chain-2',
    name: '2-tool chain',
    vanillaSteps: [
      { server: 'everything', tool: 'echo', args: { message: 'data' } },
      { server: 'everything', tool: 'add', args: { a: 1, b: 2 } },
    ],
    whitenoiseCode: `
import { echo } from 'mcp/servers/everything/echo';
import { add } from 'mcp/servers/everything/add';
const out = await echo({ message: 'data' });
const sum = await add({ a: 1, b: 2 });
console.log(JSON.stringify({ out, sum }));
`,
  },
  {
    id: 'chain-3',
    name: '3-tool chain',
    vanillaSteps: [
      { server: 'everything', tool: 'echo', args: { message: 'step1' } },
      { server: 'everything', tool: 'add', args: { a: 1, b: 2 } },
      { server: 'everything', tool: 'echo', args: { message: 'done' } },
    ],
    whitenoiseCode: `
import { echo } from 'mcp/servers/everything/echo';
import { add } from 'mcp/servers/everything/add';
const e = await echo({ message: 'step1' });
const sum = await add({ a: 1, b: 2 });
const e2 = await echo({ message: 'done' });
console.log(JSON.stringify({ e, sum, e2 }));
`,
  },
  {
    id: 'chain-5',
    name: '5-tool chain',
    vanillaSteps: [
      { server: 'everything', tool: 'echo', args: { message: 'a' } },
      { server: 'everything', tool: 'add', args: { a: 1, b: 1 } },
      { server: 'everything', tool: 'echo', args: { message: 'b' } },
      { server: 'everything', tool: 'add', args: { a: 2, b: 2 } },
      { server: 'everything', tool: 'echo', args: { message: 'five' } },
    ],
    whitenoiseCode: `
import { echo } from 'mcp/servers/everything/echo';
import { add } from 'mcp/servers/everything/add';
await echo({ message: 'a' });
const x = await add({ a: 1, b: 1 });
await echo({ message: 'b' });
const y = await add({ a: 2, b: 2 });
await echo({ message: 'five' });
console.log(JSON.stringify({ x, y }));
`,
  },
];

export function getScenarios(): Scenario[] {
  return [...SCENARIOS];
}

export function getScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
