import type { AgentAdapterKind, AgentRole, RunMode } from '@/lib/protocol/types';

export type CliAdapterKind = Exclude<AgentAdapterKind, 'mock'>;

const DEFAULT_CLI_ADAPTER_BY_ROLE: Record<AgentRole, CliAdapterKind> = {
  orchestrator: 'tmux-codex',
  planner: 'tmux-codex',
  engineer: 'tmux-codex',
  reviewer: 'tmux-codex',
};

const ROLE_ENV_KEYS: Record<AgentRole, string> = {
  orchestrator: 'AGENTBOARD_ORCHESTRATOR_ADAPTER',
  planner: 'AGENTBOARD_PLANNER_ADAPTER',
  engineer: 'AGENTBOARD_ENGINEER_ADAPTER',
  reviewer: 'AGENTBOARD_REVIEWER_ADAPTER',
};

export function isCliAdapterKind(value: string): value is CliAdapterKind {
  return value === 'codex' || value === 'tmux-codex';
}

export function resolveCliAdapterForRole(role: AgentRole, env: NodeJS.ProcessEnv = process.env): CliAdapterKind {
  const configured = env[ROLE_ENV_KEYS[role]]?.trim().toLowerCase();
  if (configured) {
    if (!isCliAdapterKind(configured)) {
      throw new Error(`${ROLE_ENV_KEYS[role]} must be codex or tmux-codex`);
    }
    return configured;
  }
  return DEFAULT_CLI_ADAPTER_BY_ROLE[role];
}

export function resolveAdapterForRole(role: AgentRole, mode: RunMode, env: NodeJS.ProcessEnv = process.env): AgentAdapterKind {
  if (mode === 'mock') return 'mock';
  return resolveCliAdapterForRole(role, env);
}
