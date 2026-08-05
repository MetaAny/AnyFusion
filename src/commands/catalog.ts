import type Database from 'better-sqlite3';
import type { TaskEngine } from '../task/task-engine.js';
import type { MemoryEngine } from '../memory/memory-engine.js';
import type { OrchestrationEngine } from '../guidance/orchestration.js';
import type { Config } from '../core/types.js';
import type { ActiveExecutionControl } from '../execution/active-execution-control.js';
import type { CommandReadServices } from './command-read-services.js';
import type { TaskControlPort } from './task-control-port.js';

export interface CommandContext {
  taskEngine: TaskEngine;
  memoryEngine: MemoryEngine;
  orchestration: OrchestrationEngine;
  activeExecutions: ActiveExecutionControl;
  taskControl: TaskControlPort;
  readServices: CommandReadServices;
  refreshExecutors?(agentClassNames?: string[]): Promise<{
    checked: string[];
    recovered: string[];
    stillError: string[];
    skipped: string[];
  }>;
  currentTaskId: string | null;
  db: Database.Database;
  config: Config;
}

export type CommandDirective =
  | {
      kind: 'start-executor-register-wizard';
    }
  | {
      kind: 'resume-task';
      taskId: string;
      mode: 'resume-parked' | 'resume-blocked';
      newlyProvidedResources?: string[];
      blockedReason?: string;
    }
  | {
      kind: 'show-task-recovery';
      taskId: string;
    }
  | {
      kind: 'resolve-task-recovery';
      taskId: string;
      recoveryItemId: string;
      resolution: 'assume_applied' | 'retry';
    };

export type CommandResult =
  | {
      type: 'text' | 'table' | 'dashboard' | 'confirm';
      content: string;
      payload?: unknown;
    }
  | {
      type: 'directive';
      content: string;
      directive: CommandDirective;
      payload?: unknown;
    }
  | {
      type: 'exit';
      content: string;
    };

export interface CommandCandidate {
  value: string;
  label: string;
  description: string;
}

export interface CommandSuggestion extends CommandCandidate {
  replacement: {
    start: number;
    end: number;
    text: string;
  };
}

export interface CommandCompletion {
  state: 'inactive' | 'incomplete' | 'executable' | 'invalid';
  suggestions: CommandSuggestion[];
  hint: string | null;
  error: string | null;
}

export interface ResolvedCommandArgs {
  positionals: Record<string, string | string[] | undefined>;
  options: Record<string, string | string[] | boolean | undefined>;
}

export type CommandCandidateProvider = (
  context: CommandContext,
  prefix: string,
) => CommandCandidate[];

export interface CommandArgumentSpec {
  name: string;
  kind: 'enum' | 'text' | 'rest' | 'variadic' | 'reference' | 'command-path';
  description: string;
  optional?: boolean;
  values?: Array<{ value: string; description: string }>;
  candidates?: CommandCandidateProvider;
  validate?: (value: string, context: CommandContext) => string | null;
}

export interface CommandOptionSpec {
  name: `--${string}`;
  description: string;
  value?: CommandArgumentSpec;
  repeatable?: boolean;
}

interface CommandNodeBase {
  name: string;
  summary: string;
  category?: 'common' | 'advanced';
}

export interface CommandGroup extends CommandNodeBase {
  kind: 'group';
  children: CommandNode[];
  fallbackAction?: CommandAction;
}

export interface CommandAction extends CommandNodeBase {
  kind: 'action';
  effect: string;
  usages: string[];
  examples: string[];
  arguments?: CommandArgumentSpec[];
  options?: CommandOptionSpec[];
  builtin?: 'help';
  execute?: (
    args: ResolvedCommandArgs,
    context: CommandContext,
  ) => Promise<CommandResult>;
}

export type CommandNode = CommandGroup | CommandAction;

interface LexToken {
  value: string;
  start: number;
  end: number;
  closed: boolean;
}

interface ParseActionResult {
  state: 'incomplete' | 'executable' | 'invalid';
  args: ResolvedCommandArgs;
  hint: string | null;
  error: string | null;
}

interface ResolvedPath {
  action: CommandAction | null;
  group: CommandGroup | null;
  actionTokenIndex: number;
  error: string | null;
  nearest: string | null;
  path: string[];
}

// Reference candidates are full sets independent of prefix (providers ignore the
// prefix argument and only return the full candidate list; prefix filtering is
// done by the caller). Cache once per argument so changing the prefix mid-input
// does not re-run the provider (which typically hits the DB via findAll()).
type CandidateCache = Map<CommandArgumentSpec, CommandCandidate[]>;

const SUGGESTION_LIMIT = 6;

function decodeToken(source: string): { value: string; closed: boolean } {
  let value = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of source) {
    if (escaping) {
      value += char;
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else value += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    value += char;
  }

  if (escaping) value += '\\';
  return { value, closed: quote === null };
}

function lexCommand(input: string): LexToken[] {
  const tokens: LexToken[] = [];
  let start = -1;
  let quote: '"' | "'" | null = null;
  let escaping = false;

  const push = (end: number) => {
    if (start < 0) return;
    const decoded = decodeToken(input.slice(start, end));
    tokens.push({ value: decoded.value, start, end, closed: decoded.closed });
    start = -1;
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (start < 0 && !/\s/.test(char)) start = index;
    if (start < 0) continue;

    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) push(index);
  }
  push(input.length);
  return tokens;
}

function levenshtein(left: string, right: string): number {
  const rows = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = 0; i <= left.length; i += 1) rows[i]![0] = i;
  for (let j = 0; j <= right.length; j += 1) rows[0]![j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      rows[i]![j] = Math.min(
        rows[i - 1]![j]! + 1,
        rows[i]![j - 1]! + 1,
        rows[i - 1]![j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
  }
  return rows[left.length]![right.length]!;
}

function nearestNode(value: string, nodes: CommandNode[]): string | null {
  const ranked = nodes
    .map(node => ({ name: node.name, distance: levenshtein(value, node.name) }))
    .sort((left, right) => left.distance - right.distance || left.name.localeCompare(right.name));
  const best = ranked[0];
  return best && best.distance <= Math.max(2, Math.floor(value.length / 2)) ? best.name : null;
}

function optionKey(name: string): string {
  return name.slice(2).replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
}

function positionalValue(args: ResolvedCommandArgs, name: string): string | undefined {
  const value = args.positionals[name];
  return typeof value === 'string' ? value : undefined;
}

export function stringArg(args: ResolvedCommandArgs, name: string): string {
  return positionalValue(args, name) ?? '';
}

export function optionalStringArg(args: ResolvedCommandArgs, name: string): string | undefined {
  return positionalValue(args, name);
}

export function stringListArg(args: ResolvedCommandArgs, name: string): string[] {
  const value = args.positionals[name];
  return Array.isArray(value) ? value : [];
}

export function optionArg(args: ResolvedCommandArgs, name: string): string | undefined {
  const value = args.options[optionKey(name)];
  return typeof value === 'string' ? value : undefined;
}

function describeArgument(argument: CommandArgumentSpec): string {
  const marker = argument.kind === 'rest' || argument.kind === 'variadic'
    ? `<${argument.name}...>`
    : `<${argument.name}>`;
  return argument.optional ? `[${marker}]` : marker;
}

function renderUsage(action: CommandAction, path: string[]): string[] {
  if (action.usages.length > 0) return action.usages;
  const base = `/${[...path, action.name].join(' ')}`;
  const argumentsText = (action.arguments ?? []).map(describeArgument).join(' ');
  return [`${base}${argumentsText ? ` ${argumentsText}` : ''}`];
}

export class CommandCatalog {
  constructor(private readonly roots: CommandNode[]) {}

  listActions(): string[] {
    const actions: string[] = [];
    const visit = (nodes: CommandNode[], path: string[]) => {
      for (const node of nodes) {
        if (node.kind === 'group') {
          const groupPath = [...path, node.name];
          if (node.fallbackAction) {
            const firstArgument = node.fallbackAction.arguments?.[0];
            actions.push(`/${groupPath.join(' ')}${firstArgument ? ` ${describeArgument(firstArgument)}` : ''}`);
          }
          visit(node.children, groupPath);
        } else actions.push(`/${[...path, node.name].join(' ')}`);
      }
    };
    visit(this.roots, []);
    return actions;
  }

  describe(commandPath?: string | string[]): string {
    const path = Array.isArray(commandPath)
      ? commandPath.filter(Boolean)
      : (commandPath ?? '').trim().replace(/^\//, '').split(/\s+/).filter(Boolean);

    if (path.length === 0) {
      const lines = ['MetaClaw 命令树', ''];
      const renderNodes = (nodes: CommandNode[], parentPath: string[], depth: number) => {
        for (const node of nodes) {
          const currentPath = [...parentPath, node.name];
          lines.push(`${'  '.repeat(depth)}/${currentPath.join(' ')}  ${node.summary}`);
          if (node.kind === 'group') {
            if (node.fallbackAction) {
              const firstArgument = node.fallbackAction.arguments?.[0];
              const fallbackPath = `/${currentPath.join(' ')}${firstArgument ? ` ${describeArgument(firstArgument)}` : ''}`;
              lines.push(`${'  '.repeat(depth + 1)}${fallbackPath}  ${node.fallbackAction.summary}`);
            }
            renderNodes(node.children, currentPath, depth + 1);
          }
        }
      };
      for (const category of ['common', 'advanced'] as const) {
        const nodes = this.roots.filter(node => (node.category ?? 'advanced') === category);
        if (nodes.length === 0) continue;
        lines.push(category === 'common' ? '常用：' : '高级：');
        renderNodes(nodes, [], 1);
        lines.push('');
      }
      lines.push('使用 /help <命令路径> 查看详细说明，例如 /help task pause。');
      return lines.join('\n').trimEnd();
    }

    let nodes = this.roots;
    const traversed: string[] = [];
    for (let index = 0; index < path.length; index += 1) {
      const segment = path[index]!;
      const node = nodes.find(candidate => candidate.name === segment);
      if (!node) return `未找到命令路径: /${path.join(' ')}`;
      traversed.push(node.name);
      if (node.kind === 'action') {
        if (index !== path.length - 1) return `未找到命令路径: /${path.join(' ')}`;
        return [
          `/${traversed.join(' ')} — ${node.summary}`,
          '',
          `效果：${node.effect}`,
          '',
          '用法：',
          ...renderUsage(node, traversed.slice(0, -1)).map(usage => `  ${usage}`),
          ...(node.examples.length > 0 ? ['', '示例：', ...node.examples.map(example => `  ${example}`)] : []),
        ].join('\n');
      }
      nodes = node.children;
    }

    const lines = [`/${traversed.join(' ')} — 命令目录`, ''];
    const resolvedGroup = path.reduce<CommandGroup | null>((group, segment, index) => {
      const candidates = index === 0 ? this.roots : group?.children ?? [];
      const node = candidates.find(candidate => candidate.name === segment);
      return node?.kind === 'group' ? node : null;
    }, null);
    if (resolvedGroup?.fallbackAction) {
      const firstArgument = resolvedGroup.fallbackAction.arguments?.[0];
      lines.push(`  ${(firstArgument ? describeArgument(firstArgument) : resolvedGroup.fallbackAction.name).padEnd(18)} ${resolvedGroup.fallbackAction.summary}`);
    }
    for (const node of nodes) lines.push(`  ${node.name.padEnd(18)} ${node.summary}`);
    return lines.join('\n');
  }

  complete(input: { text: string; cursor: number; context: CommandContext }): CommandCompletion {
    const { text, context } = input;
    const cursor = Math.max(0, Math.min(input.cursor, text.length));
    if (!text.startsWith('/')) {
      return { state: 'inactive', suggestions: [], hint: null, error: null };
    }

    const tokens = lexCommand(text);
    const activeToken = tokens.find(token =>
      cursor >= token.start
      && cursor <= token.end
    ) ?? null;
    const replacement = activeToken
      ? { start: activeToken.start, end: activeToken.end }
      : { start: cursor, end: cursor };
    const rawPrefix = activeToken ? decodeToken(text.slice(activeToken.start, cursor)).value : '';
    const prefix = replacement.start === 0 ? rawPrefix.replace(/^\//, '') : rawPrefix;
    const beforeTokens = tokens.filter(token => token.end <= replacement.start);
    const before = beforeTokens
      .map((token, index) => index === 0 ? token.value.replace(/^\//, '') : token.value);
    const candidateCache: CandidateCache = new Map();

    const resolved = this.resolvePath(before);
    if (resolved.error) {
      const invalidToken = beforeTokens[resolved.path.length];
      const nearest = resolved.nearest && invalidToken
        ? this.nodeSuggestion(
            resolved.nearest,
            resolved.group ? resolved.group.children : this.roots,
            {
              start: invalidToken.start,
              end: invalidToken.end,
            },
          )
        : null;
      return { state: 'invalid', suggestions: nearest ? [nearest] : [], hint: null, error: resolved.error };
    }

    if (!resolved.action) {
      const nodes = resolved.group ? resolved.group.children : this.roots;
      const nodeSuggestions = nodes
        .filter(node => node.name.toLowerCase().startsWith(prefix.toLowerCase()))
        .map(node => this.nodeSuggestion(node.name, nodes, replacement));
      if (nodeSuggestions.length === 0 && prefix) {
        const nearest = nearestNode(prefix, nodes);
        if (nearest) nodeSuggestions.push(this.nodeSuggestion(nearest, nodes, replacement));
      }
      const fallbackArgument = resolved.group?.fallbackAction?.arguments?.[0];
      const fallbackSuggestions = fallbackArgument
        ? this.suggestArgument(fallbackArgument, prefix, replacement, context, false, candidateCache).suggestions
        : [];
      const suggestions = [...nodeSuggestions, ...fallbackSuggestions]
        .filter((candidate, index, all) => all.findIndex(item => item.value === candidate.value) === index)
        .slice(0, SUGGESTION_LIMIT);
      const exactNode = nodes.find(node => node.name === prefix);
      const exactActionState = exactNode?.kind === 'action'
        ? this.parseAction(exactNode, [], context, true, candidateCache).state
        : 'incomplete';
      const fallbackState = resolved.group?.fallbackAction && prefix
        ? this.parseAction(resolved.group.fallbackAction, [prefix], context, true, candidateCache).state
        : 'incomplete';
      return {
        state: exactActionState === 'executable' || fallbackState === 'executable' ? 'executable' : 'incomplete',
        suggestions,
        hint: suggestions.length === 0 ? '暂无匹配候选。' : null,
        error: null,
      };
    }

    const actionTokens = before.slice(resolved.actionTokenIndex + 1);
    if (resolved.action.builtin === 'help') {
      return this.completeHelpPath(actionTokens, prefix, replacement);
    }
    return this.completeAction(resolved.action, actionTokens, prefix, replacement, context, candidateCache);
  }

  async execute(input: string, context: CommandContext): Promise<CommandResult> {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return { type: 'text', content: '无效命令' };
    const tokens = lexCommand(trimmed);
    if (tokens.some(token => !token.closed)) {
      return { type: 'text', content: '命令包含未闭合的引号。' };
    }
    const values = tokens.map((token, index) => index === 0 ? token.value.replace(/^\//, '') : token.value);
    const resolved = this.resolvePath(values);
    if (resolved.error || !resolved.action) {
      const suggestion = resolved.nearest ? ` 你是否想输入 /${[...resolved.path, resolved.nearest].join(' ')}？` : '';
      return {
        type: 'text',
        content: `${resolved.error ?? `命令不完整: /${values.join(' ')}`}。${suggestion} 输入 /help 查看命令树。`,
      };
    }

    const parsed = this.parseAction(
      resolved.action,
      values.slice(resolved.actionTokenIndex + 1),
      context,
      false,
      new Map(),
    );
    if (parsed.state !== 'executable') {
      return { type: 'text', content: parsed.error ?? parsed.hint ?? `命令不完整: /${values.join(' ')}` };
    }

    const commandPath = `/${resolved.path.join(' ')}`;
    if (resolved.action.builtin === 'help') {
      return {
        type: 'text',
        content: this.describe(stringListArg(parsed.args, 'commandPath')),
      };
    }
    if (!resolved.action.execute) {
      return { type: 'text', content: `命令没有执行实现: ${commandPath}` };
    }
    return resolved.action.execute(parsed.args, context);
  }

  private resolvePath(tokens: string[]): ResolvedPath {
    let nodes = this.roots;
    let group: CommandGroup | null = null;
    const path: string[] = [];

    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      const node = nodes.find(candidate => candidate.name === token);
      if (!node) {
        if (group?.fallbackAction) {
          return {
            action: group.fallbackAction,
            group,
            actionTokenIndex: index - 1,
            error: null,
            nearest: null,
            path,
          };
        }
        return {
          action: null,
          group,
          actionTokenIndex: -1,
          error: `未知命令节点: ${token}`,
          nearest: nearestNode(token, nodes),
          path,
        };
      }
      path.push(node.name);
      if (node.kind === 'action') {
        return {
          action: node,
          group,
          actionTokenIndex: index,
          error: null,
          nearest: null,
          path,
        };
      }
      group = node;
      nodes = node.children;
    }

    return { action: null, group, actionTokenIndex: -1, error: null, nearest: null, path };
  }

  private parseAction(
    action: CommandAction,
    tokens: string[],
    context: CommandContext,
    allowIncomplete: boolean,
    candidateCache: CandidateCache,
  ): ParseActionResult {
    const options: Record<string, string | string[] | boolean | undefined> = {};
    const positionalTokens: string[] = [];
    const optionSpecs = new Map((action.options ?? []).map(option => [option.name, option]));
    let positionalOnly = false;

    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (!positionalOnly && token === '--') {
        positionalOnly = true;
        continue;
      }
      if (!positionalOnly && token.startsWith('--')) {
        const option = optionSpecs.get(token as `--${string}`);
        if (!option) return this.invalid(`未知选项: ${token}`);
        const key = optionKey(option.name);
        if (!option.repeatable && options[key] !== undefined) return this.invalid(`选项不能重复: ${option.name}`);
        if (!option.value) {
          options[key] = true;
          continue;
        }
        const value = tokens[index + 1];
        if (!value) return allowIncomplete ? this.incomplete(`请输入 ${option.name} 的值。`) : this.invalid(`选项缺少值: ${option.name}`);
        const valueError = this.validateValue(option.value, value, context, candidateCache);
        if (valueError) return this.invalid(valueError);
        if (option.repeatable) {
          const existing = options[key];
          options[key] = [...(Array.isArray(existing) ? existing : []), value];
        } else {
          options[key] = value;
        }
        index += 1;
        continue;
      }
      positionalTokens.push(token);
    }

    const positionals: Record<string, string | string[] | undefined> = {};
    let tokenIndex = 0;
    for (const argument of action.arguments ?? []) {
      if (argument.kind === 'rest') {
        const remaining = positionalTokens.slice(tokenIndex);
        if (remaining.length === 0 && !argument.optional) {
          return allowIncomplete ? this.incomplete(`请输入${argument.description}。`) : this.invalid(`缺少参数: ${argument.name}`);
        }
        positionals[argument.name] = remaining.length > 0 ? remaining.join(' ') : undefined;
        tokenIndex = positionalTokens.length;
        continue;
      }
      if (argument.kind === 'variadic' || argument.kind === 'command-path') {
        const remaining = positionalTokens.slice(tokenIndex);
        if (remaining.length === 0 && !argument.optional) {
          return allowIncomplete ? this.incomplete(`请输入${argument.description}。`) : this.invalid(`缺少参数: ${argument.name}`);
        }
        for (const value of remaining) {
          const valueError = this.validateValue(argument, value, context, candidateCache);
          if (valueError) return this.invalid(valueError);
        }
        positionals[argument.name] = remaining;
        tokenIndex = positionalTokens.length;
        continue;
      }

      const value = positionalTokens[tokenIndex];
      if (!value) {
        if (argument.optional) {
          positionals[argument.name] = undefined;
          continue;
        }
        return allowIncomplete ? this.incomplete(`请输入${argument.description}。`) : this.invalid(`缺少参数: ${argument.name}`);
      }
      const valueError = this.validateValue(argument, value, context, candidateCache);
      if (valueError) return this.invalid(valueError);
      positionals[argument.name] = value;
      tokenIndex += 1;
    }

    if (tokenIndex < positionalTokens.length) {
      return this.invalid(`多余参数: ${positionalTokens.slice(tokenIndex).join(' ')}`);
    }

    return {
      state: 'executable',
      args: { positionals, options },
      hint: null,
      error: null,
    };
  }

  private completeAction(
    action: CommandAction,
    completedTokens: string[],
    prefix: string,
    replacement: { start: number; end: number },
    context: CommandContext,
    candidateCache: CandidateCache,
  ): CommandCompletion {
    const optionSpecs = action.options ?? [];
    const usedOptions = new Set<string>();
    const positionalTokens: string[] = [];
    let expectedOptionValue: CommandOptionSpec | null = null;
    let positionalOnly = false;

    for (let index = 0; index < completedTokens.length; index += 1) {
      const token = completedTokens[index]!;
      if (!positionalOnly && token === '--') {
        positionalOnly = true;
        continue;
      }
      if (!positionalOnly && token.startsWith('--')) {
        const option = optionSpecs.find(candidate => candidate.name === token);
        if (!option) return { state: 'invalid', suggestions: [], hint: null, error: `未知选项: ${token}` };
        usedOptions.add(option.name);
        if (option.value) {
          const value = completedTokens[index + 1];
          if (!value) {
            expectedOptionValue = option;
            break;
          }
          index += 1;
        }
        continue;
      }
      positionalTokens.push(token);
    }

    if (expectedOptionValue?.value) {
      const result = this.suggestArgument(expectedOptionValue.value, prefix, replacement, context, false, candidateCache);
      const parsed = this.parseAction(
        action,
        prefix ? [...completedTokens, prefix] : completedTokens,
        context,
        true,
        candidateCache,
      );
      result.state = parsed.state;
      result.error = parsed.error;
      return result;
    }

    if (prefix.startsWith('--')) {
      const suggestions = optionSpecs
        .filter(option => (option.repeatable || !usedOptions.has(option.name)) && option.name.startsWith(prefix))
        .slice(0, SUGGESTION_LIMIT)
        .map(option => ({
          value: option.name,
          label: option.name,
          description: option.description,
          replacement: { ...replacement, text: option.name },
        }));
      return { state: 'incomplete', suggestions, hint: suggestions.length ? null : '没有匹配的选项。', error: null };
    }

    const argumentsSpecs = action.arguments ?? [];
    let consumed = 0;
    let expected: CommandArgumentSpec | null = null;
    for (const argument of argumentsSpecs) {
      if (argument.kind === 'rest' || argument.kind === 'variadic' || argument.kind === 'command-path') {
        expected = argument;
        break;
      }
      if (consumed < positionalTokens.length) consumed += 1;
      else {
        expected = argument;
        break;
      }
    }

    if (expected) {
      const parsedWithActive = this.parseAction(
        action,
        prefix ? [...completedTokens, prefix] : completedTokens,
        context,
        true,
        candidateCache,
      );
      const result = this.suggestArgument(expected, prefix, replacement, context, expected.optional ?? false, candidateCache);
      result.state = parsedWithActive.state;
      result.error = parsedWithActive.error;
      if (parsedWithActive.hint && result.suggestions.length === 0) result.hint = parsedWithActive.hint;
      return result;
    }

    const parsed = this.parseAction(action, prefix ? [...completedTokens, prefix] : completedTokens, context, true, candidateCache);
    const optionSuggestions = prefix === ''
      ? optionSpecs
        .filter(option => option.repeatable || !usedOptions.has(option.name))
        .slice(0, SUGGESTION_LIMIT)
        .map(option => ({
          value: option.name,
          label: option.name,
          description: option.description,
          replacement: { ...replacement, text: option.name },
        }))
      : [];
    return {
      state: parsed.state,
      suggestions: optionSuggestions,
      hint: parsed.hint,
      error: parsed.error,
    };
  }

  private findGroup(path: string[]): CommandGroup | null {
    let nodes = this.roots;
    let group: CommandGroup | null = null;
    for (const segment of path) {
      const node = nodes.find(candidate => candidate.name === segment);
      if (!node || node.kind !== 'group') return null;
      group = node;
      nodes = node.children;
    }
    return group;
  }

  private completeHelpPath(
    completedPath: string[],
    prefix: string,
    replacement: { start: number; end: number },
  ): CommandCompletion {
    let nodes = this.roots;
    for (const segment of completedPath) {
      const node = nodes.find(candidate => candidate.name === segment);
      if (!node) return { state: 'invalid', suggestions: [], hint: null, error: `未知命令路径: /${completedPath.join(' ')}` };
      if (node.kind === 'action') return { state: 'invalid', suggestions: [], hint: null, error: `命令路径不能继续: /${completedPath.join(' ')}` };
      nodes = node.children;
    }
    const suggestions = nodes
      .filter(node => node.name.toLowerCase().startsWith(prefix.toLowerCase()))
      .slice(0, SUGGESTION_LIMIT)
      .map(node => ({
        value: node.name,
        label: node.name,
        description: node.summary,
        replacement: { ...replacement, text: node.name },
      }));
    const exact = prefix ? nodes.find(node => node.name === prefix) : null;
    return {
      state: prefix === '' || Boolean(exact) ? 'executable' : 'incomplete',
      suggestions,
      hint: suggestions.length === 0 && prefix ? '暂无匹配命令路径。' : null,
      error: null,
    };
  }

  private suggestArgument(
    argument: CommandArgumentSpec,
    prefix: string,
    replacement: { start: number; end: number },
    context: CommandContext,
    executableWhenEmpty: boolean,
    candidateCache: CandidateCache,
  ): CommandCompletion {
    if (argument.kind === 'command-path') {
      const path = prefix ? [prefix] : [];
      const nodes = this.commandPathCandidates([], path[0] ?? '');
      return {
        state: executableWhenEmpty ? 'executable' : 'incomplete',
        suggestions: nodes.slice(0, SUGGESTION_LIMIT).map(candidate => ({
          ...candidate,
          replacement: { ...replacement, text: candidate.value },
        })),
        hint: null,
        error: null,
      };
    }

    const candidates = argument.kind === 'enum'
      ? (argument.values ?? []).map(value => ({ value: value.value, label: value.value, description: value.description }))
      : this.referenceCandidates(argument, context, prefix, candidateCache);
    const filtered = candidates
      .filter(candidate => candidate.value.toLowerCase().startsWith(prefix.toLowerCase())
        || candidate.label.toLowerCase().startsWith(prefix.toLowerCase()))
      .slice(0, SUGGESTION_LIMIT);
    return {
      state: executableWhenEmpty ? 'executable' : 'incomplete',
      suggestions: filtered.map(candidate => ({
        ...candidate,
        replacement: { ...replacement, text: candidate.value },
      })),
      hint: filtered.length === 0 ? `请输入${argument.description}。` : null,
      error: null,
    };
  }

  private commandPathCandidates(path: string[], prefix: string): CommandCandidate[] {
    let nodes = this.roots;
    for (const segment of path) {
      const node = nodes.find(candidate => candidate.name === segment);
      if (!node || node.kind !== 'group') return [];
      nodes = node.children;
    }
    return nodes
      .filter(node => node.name.startsWith(prefix))
      .map(node => ({ value: node.name, label: node.name, description: node.summary }));
  }

  private validateValue(
    argument: CommandArgumentSpec,
    value: string,
    context: CommandContext,
    candidateCache: CandidateCache,
  ): string | null {
    if (argument.kind === 'enum' && !(argument.values ?? []).some(candidate => candidate.value === value)) {
      return `参数 ${argument.name} 的值无效: ${value}`;
    }
    if (argument.validate) return argument.validate(value, context);
    if (
      argument.kind === 'reference'
      && !this.referenceCandidates(argument, context, value, candidateCache).some(candidate => candidate.value === value)
    ) {
      return `${argument.description}不存在: ${value}`;
    }
    return null;
  }

  private referenceCandidates(
    argument: CommandArgumentSpec,
    context: CommandContext,
    prefix: string,
    candidateCache: CandidateCache,
  ): CommandCandidate[] {
    if (!argument.candidates) return [];
    const cached = candidateCache.get(argument);
    if (cached) return cached;
    const candidates = argument.candidates(context, prefix);
    candidateCache.set(argument, candidates);
    return candidates;
  }

  private nodeSuggestion(
    name: string,
    nodes: CommandNode[],
    replacement: { start: number; end: number },
  ): CommandSuggestion {
    const node = nodes.find(candidate => candidate.name === name)!;
    const text = replacement.start === 0 ? `/${node.name}` : node.name;
    return {
      value: node.name,
      label: text,
      description: node.summary,
      replacement: {
        ...replacement,
        text,
      },
    };
  }

  private incomplete(hint: string): ParseActionResult {
    return { state: 'incomplete', args: { positionals: {}, options: {} }, hint, error: null };
  }

  private invalid(error: string): ParseActionResult {
    return { state: 'invalid', args: { positionals: {}, options: {} }, hint: null, error };
  }
}
