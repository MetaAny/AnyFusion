import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { z } from 'zod';
import { PlanningAgentPlanOutputSchema } from './planning/planning-agent-plan-schema.js';

const outputPath = resolve(process.argv[2] ?? 'dist/planning-agent-plan-v7.schema.json');
mkdirSync(dirname(outputPath), { recursive: true });
const schema = z.toJSONSchema(PlanningAgentPlanOutputSchema, {
  target: 'draft-7',
  unrepresentable: 'any',
});
writeFileSync(outputPath, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
