import type { AgentAdapterKind, AgentRole, RunMode } from '@/lib/protocol/types';

export type CliAdapterKind = Exclude<AgentAdapterKind, 'mock'>;

const DEFAULT_CLI_ADAPTER_BY_ROLE: Record<AgentRole, CliAdapterKind> = {
  planner: 'codex',
  engineer: 'claude',
  reviewer: 'gemini',
};

const ROLE_ENV_KEYS: Record<AgentRole, string> = {
  planner: 'AGENTBOARD_PLANNER_ADAPTER',
  engineer: 'AGENTBOARD_ENGINEER_ADAPTER',
  reviewer: 'AGENTBOARD_REVIEWER_ADAPTER',
};

export function isCliAdapterKind(value: string): value is CliAdapterKind {
  return value === 'codex' || value === 'claude' || value === 'gemini';
}

export function resolveCliAdapterForRole(role: AgentRole, env: NodeJS.ProcessEnv = process.env): CliAdapterKind {
  const configured = env[ROLE_ENV_KEYS[role]]?.trim().toLowerCase();
  if (configured) {
    if (!isCliAdapterKind(configured)) {
      throw new Error(`${ROLE_ENV_KEYS[role]} must be one of codex, claude, gemini`);
    }
    return configured;
  }
  return DEFAULT_CLI_ADAPTER_BY_ROLE[role];
}

export function resolveAdapterForRole(role: AgentRole, mode: RunMode, env: NodeJS.ProcessEnv = process.env): AgentAdapterKind {
  if (mode === 'mock') return 'mock';
  return resolveCliAdapterForRole(role, env);
}
