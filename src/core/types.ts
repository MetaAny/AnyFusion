// ─── 任务状态 ───
import type {
  ContextRef,
  WorkGraphAcceptanceCriterion,
  WorkGraphDependency,
} from '../work-graph/types.js';

export const TaskStatus = {
  CREATED: 'created',
  READY: 'ready',
  RUNNING: 'running',
  PARKED: 'parked',
  BLOCKED: 'blocked',
  DONE: 'done',
  ARCHIVED: 'archived',
  CANCELLED: 'cancelled',
} as const;

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const SubtaskStatus = {
  READY: 'ready',
  RUNNING: 'running',
  AWAITING_INTEGRATION: 'awaiting_integration',
  AWAITING_DECISION: 'awaiting_decision',
  BLOCKED: 'blocked',
  DONE: 'done',
  CANCELLED: 'cancelled',
} as const;

export type SubtaskStatus = (typeof SubtaskStatus)[keyof typeof SubtaskStatus];

// ─── 任务快照 ───
export interface TaskSnapshot {
  done: string[];           // 已完成内容
  pending: string[];        // 未完成内容
  nextStep: string;         // 下一步建议
  pauseReason: string;      // 暂停原因
  createdAt: string;        // 快照时间
}

// ─── 优先级信号 ───
export interface PrioritySignals {
  dueAt: string | null;     // 截止时间
  isReady: boolean;         // 输入是否齐全
  progressRatio: number;    // 完成比例 0-1
  blocksOthers: boolean;    // 是否阻塞其他任务
  idleHours: number;        // 搁置时长
  semanticPriority?: 'normal' | 'high' | 'urgent';
  semanticPriorityReason?: string;
}

// ─── 任务对象 ───
export interface Task {
  id: string;
  title: string;
  goal: string;
  status: TaskStatus;
  summary: string;
  snapshots: TaskSnapshot[];
  resources: string[];
  artifacts: string[];
  dependencies: Dependency[];
  prioritySignals: PrioritySignals;
  injectedPreferences: string[];
  lastSchedulingReason: string;
  lastInterruptionReason: string;
  interruptionCount: number;
  createdAt: string;
  updatedAt: string;
}

export type AgentClassKind = 'planner' | 'executor';
export type AgentClassRiskLevel = 'low' | 'medium' | 'high';

export interface AgentClass {
  name: string;
  kind: AgentClassKind;
  domains: string[];
  capabilities: string[];
  inputTypes: string[];
  outputTypes: string[];
  strengths: string[];
  weaknesses: string[];
  primaryUseCases: string[];
  avoidUseCases: string[];
  intentAffinity: Record<string, number>;
  riskLevel: AgentClassRiskLevel;
  harness: string | null;
  model: string | null;
  skills: string[];
  mcpServers: string[];
  plugins: string[];
  runtimeCommand: string | null;
  runtimeArgs: string[];
  runtimeCheckCommand: string | null;
  executionImageRef: string | null;
  resolvedImageId: string | null;
  permissionProfileId: 'workspace-engineering' | 'public-web-research' | 'restricted-custom' | null;
  projectUrl: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface Subtask {
  id: string;
  taskId: string;
  graphRevision: number;
  generationId: string;
  title: string;
  goal: string;
  status: SubtaskStatus;
  dependencies: WorkGraphDependency[];
  contextRefs: ContextRef[];
  requiredCapabilities: string[];
  preferredAgentClassList: string[];
  deliveryKind: 'edit' | 'report';
  acceptance: WorkGraphAcceptanceCriterion[];
  riskLevel: AgentClassRiskLevel;
  result: string;
  artifacts: string[];
  verification: {
    warnings: string[];
    completionSchemaVersion: number | null;
  };
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export type WorkUnitState =
  | 'starting'
  | 'idle'
  | 'claimed'
  | 'running'
  | 'waiting'
  | 'heartbeat_lost'
  | 'failed'
  | 'draining'
  | 'stopped';

export interface WorkUnit {
  id: string;
  agentClassName: string;
  agentClassKind: AgentClassKind;
  state: WorkUnitState;
  claimedTaskId: string | null;
  claimedSubtaskId: string | null;
  claimedAttemptId: string | null;
  heartbeatAt: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  subtaskId: string | null;
  eventType: string;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface WorkUnitEvent {
  id: string;
  workUnitId: string;
  taskId: string | null;
  subtaskId: string | null;
  attemptId: string | null;
  eventType: string;
  state: WorkUnitState | null;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface WorktreeLease {
  id: string;
  worktreePath: string;
  workUnitId: string;
  taskId: string;
  subtaskId: string;
  heartbeatAt: string;
  expiresAt: string;
  releasedAt: string | null;
  createdAt: string;
}

// ─── 阻塞依赖 ───
export interface Dependency {
  taskId: string;
  type: 'manual' | 'kernel_capacity' | 'kernel_retry' | 'kernel_availability';
  description: string;
  status: 'waiting' | 'resolved';
  createdAt: string;
}

// ─── 偏好作用域 ───
export const PreferenceScope = {
  GLOBAL: 'global',
  PROJECT: 'project',
  CONTACT: 'contact',
  TASK_LOCAL: 'task-local',
} as const;

export type PreferenceScope = (typeof PreferenceScope)[keyof typeof PreferenceScope];

// ─── 偏好状态 ───
export const PreferenceStatus = {
  OBSERVED: 'observed',
  CANDIDATE: 'candidate',
  CONFIRMED: 'confirmed',
  DORMANT: 'dormant',
  ARCHIVED: 'archived',
  DISCARDED: 'discarded',
} as const;

export type PreferenceStatus = (typeof PreferenceStatus)[keyof typeof PreferenceStatus];

// ─── 偏好对象 ───
export interface Preference {
  id: string;
  type: string;             // contact / style / domain / workflow
  scope: PreferenceScope;
  subject: string | null;
  content: string;
  status: PreferenceStatus;
  confidence: number;
  occurrenceCount: number;
  sourceTasks: string[];
  lastUsedAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── 主动建议 ───
export interface Suggestion {
  taskId: string;
  type: 'resume_suggestion' | 'priority_suggestion' | 'unblock_reminder';
  reasons: string[];
  recommendedAction: string;
  generatedAt: string;
}

// ─── 执行器结果 ───
export interface ExecutorResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
  durationMs: number;
  interrupted?: boolean;
  failure?: import('./kernel-failure.js').KernelFailure;
}

// ─── 恢复摘要 ───
export interface ResumeSummary {
  taskTitle: string;
  lastProgress: string;       // "上次做到哪"
  pauseReason: string;        // "为什么停下"
  currentStatus: string;      // "当前状态"
  nextStep: string;           // "建议先做什么"
  resources: string[];        // "相关材料"
  idleHours: number;          // 搁置了多久
}

// ─── 优先级评分 ───
export interface PriorityScore {
  urgency: number;          // 紧迫度：有截止时间且临近 → 高分
  readiness: number;        // 可执行度：输入齐全 → 高分
  continuityBenefit: number; // 连续性收益：已完成比例高 → 高分
  downstreamImpact: number; // 下游影响：阻塞其他任务 → 高分
  staleness: number;        // 搁置成本：长期未推进 → 高分
  total: number;            // 加权总分
}

// ─── 任务盘面 ───
export interface Dashboard {
  summary: { active: number; blocked: number; parked: number; done: number };
  priorityTask: (Task & { reasons: string[] }) | null;
  blockedTasks: Array<Task & { blockReason: string }>;
  readyTasks: Task[];
}

// ─── 调度运行态 ───
export interface RuntimeState {
  runningTaskId: string | null;
  runningExecutorName: string | null;
  readyTaskIds: string[];
  blockedTaskIds: string[];
  parkedTaskIds: string[];
  lastEvent: string | null;
}

// ─── 执行上下文包 ───
export interface TaskBrief {
  id: string;
  title: string;
  goal: string;
  status: TaskStatus;
  summary: string;
}

export interface ResumeContext {
  taskTitle: string;
  lastProgress: string;
  completedItems: string[];
  pendingItems: string[];
  pauseReason: string;
  interruptionReason?: string;
  blockedReason?: string;
  nextStep: string;
  schedulingReason?: string;
}

export interface ResolvedPreference {
  id: string;
  content: string;
  scope: PreferenceScope;
  confidence: number;
  reason: string;
}

export interface MemoryContext {
  explicitUserInstruction: string;
  resolvedPreferences: ResolvedPreference[];
}

export interface HistoryContext {
  currentConversationTurns?: Array<{
    taskId: string;
    userInput: string;
    systemOutput: string;
    createdAt: string;
    source: 'task' | 'session' | 'timeline' | 'keyword' | 'llm';
  }>;
  taskTurns: Array<{
    taskId: string;
    userInput: string;
    systemOutput: string;
    createdAt: string;
    source: 'task' | 'session' | 'timeline' | 'keyword' | 'llm';
  }>;
  sessionTurns: Array<{
    taskId: string;
    userInput: string;
    systemOutput: string;
    createdAt: string;
    source: 'task' | 'session' | 'timeline' | 'keyword' | 'llm';
  }>;
  timelineTurns: Array<{
    taskId: string;
    userInput: string;
    systemOutput: string;
    createdAt: string;
    source: 'task' | 'session' | 'timeline' | 'keyword' | 'llm';
  }>;
  relatedTurns: Array<{
    taskId: string;
    userInput: string;
    systemOutput: string;
    createdAt: string;
    source: 'task' | 'session' | 'timeline' | 'keyword' | 'llm';
  }>;
}

export interface MaterialContext {
  resources: string[];
  textSnippets?: Array<{
    path: string;
    content: string;
    sourceType: 'file' | 'link';
  }>;
  summary?: {
    totalCount: number;
    localFileCount: number;
    webLinkCount: number;
    fileSnippetCount: number;
    linkSnippetCount: number;
    readableSnippetCount: number;
    status: 'missing' | 'partial' | 'ready';
    overview: string;
    sufficiency: string;
  };
}

export interface WorkspaceContext {
  allowFilesystem: boolean;
  workingDirectory: string;
  targetPaths: string[];
}

export interface ExecutionContextBundleV2 {
  mode: 'fresh' | 'resume-parked' | 'resume-blocked' | 'follow-up';
  taskBrief: TaskBrief;
  resumeContext?: ResumeContext;
  memoryContext: MemoryContext;
  historyContext: HistoryContext;
  materialContext: MaterialContext;
  workspaceContext?: WorkspaceContext;
  executionInstructions: string[];
}

export type ExecutionContextBundle = ExecutionContextBundleV2;

export type TaskRecoveryTriggerKind =
  | 'timer-recheck'
  | 'user-query-unblocked'
  | 'natural-language-resume'
  | 'explicit-task-command'
  | 'proposal';

export interface TaskRecoveryTrigger {
  kind: TaskRecoveryTriggerKind;
  blockedReason: string;
  triggerReason: string;
  sourceInputExcerpt?: string;
  newlyProvidedResources?: string[];
}

// ─── V2 主动提案 ───
export const GuidanceActionType = {
  RESUME_TASK: 'resume_task',
  UNBLOCK_AND_RESUME: 'unblock_and_resume',
  CONTINUE_FOLLOWUP: 'continue_followup',
  PRIORITIZE_TASK: 'prioritize_task',
  RESUME_SIMILAR_TASK: 'resume_similar_task',
  REVIEW_GENERATED_ARTIFACT: 'review_generated_artifact',
} as const;

export type GuidanceActionType = (typeof GuidanceActionType)[keyof typeof GuidanceActionType];

export interface GuidanceProposal {
  id: string;
  trigger: string;
  taskId: string | null;
  actionType: GuidanceActionType;
  recommendedAction: string;
  reasons: string[];
  confidence: number;
  requiresConfirmation: boolean;
  proposalPayload: Record<string, unknown>;
  expiresAt: string | null;
  createdAt: string;
}

// ─── 配置 ───
export interface Config {
  version: number;
  executor: {
    command: string;
    timeout: number;
    max_duration?: number;
  };
  orchestration: {
    reminder_enabled: boolean;
    reminder_throttle: number;
    top_k_preferences: number;
    blocked_recheck_enabled?: boolean;
    blocked_recheck_interval?: number;
    max_concurrent_attempts: number;
  };
  ui: {
    language: string;
    dashboard_on_start: boolean;
  };
  notifications?: {
    feishu?: {
      enabled: boolean;
      webhook_url?: string;
      secret?: string;
    };
  };
  integrations?: {
    markdown_preview?: {
      enabled: boolean;
      host: string;
      port: number;
      public_base_url?: string;
    };
  };
  gateway?: {
    enabled: boolean;
    platforms?: {
      feishu?: {
        enabled: boolean;
        domain?: 'feishu' | 'lark';
        connection_mode?: 'websocket' | 'webhook';
        app_id?: string;
        app_secret_env?: string;
        event_port?: number;
        event_path?: string;
        verification_token?: string;
        encrypt_key_env?: string;
        access?: {
          dm_policy?: 'pairing' | 'allow_all' | 'allowlist';
          allowed_users?: string[];
          group_policy?: 'open' | 'disabled' | 'allowlist' | 'admin_only';
          require_mention?: boolean;
        };
        delivery?: {
          final_markdown_mode?: 'card' | 'post';
          fallback_mode?: 'post' | 'file';
          final_file_fallback?: boolean;
        };
        home_channel?: string;
      };
    };
  };
}
