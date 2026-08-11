import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.OPENAI_BASE_URL ??= 'http://127.0.0.1:1/v1';
process.env.OPENAI_API_KEY ??= 'metaclaw-test-placeholder';

const executorRoot = '/tmp';
const codexHome = join(executorRoot, 'codex-home');
const piHome = join(executorRoot, 'pi-home');
const piAgentHome = join(piHome, '.pi', 'agent');
const executorEnvironment = join(executorRoot, 'executor.env');
mkdirSync(codexHome, { recursive: true });
mkdirSync(piAgentHome, { recursive: true });
writeFileSync(join(codexHome, 'config.toml'), [
  'model_provider = "test"',
  '[model_providers.test]',
  `base_url = "${process.env.OPENAI_BASE_URL}"`,
  'env_key = "OPENAI_API_KEY"',
].join('\n'));
writeFileSync(join(piAgentHome, 'models.json'), JSON.stringify({
  providers: { test: { baseUrl: process.env.OPENAI_BASE_URL } },
}));
writeFileSync(join(piAgentHome, 'settings.json'), '{}');
writeFileSync(executorEnvironment, [
  `OPENAI_BASE_URL=${process.env.OPENAI_BASE_URL}`,
  `OPENAI_API_KEY=${process.env.OPENAI_API_KEY}`,
].join('\n'));
process.env.METACLAW_EXECUTOR_CODEX_HOME ??= codexHome;
process.env.METACLAW_EXECUTOR_PI_HOME ??= piHome;
process.env.METACLAW_CODEX_EXECUTOR_ENV_FILE ??= executorEnvironment;
process.env.METACLAW_PI_EXECUTOR_ENV_FILE ??= executorEnvironment;
