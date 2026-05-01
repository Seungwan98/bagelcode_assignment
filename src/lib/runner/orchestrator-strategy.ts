import type { AgentRole, RunState } from '@/lib/protocol/types';

export interface OrchestratorStrategy {
  id: string;
  selectRoles(state: RunState): AgentRole[];
}

export const DEFAULT_AGENT_EXECUTION_ORDER: AgentRole[] = ['planner', 'engineer', 'reviewer'];

export function createLinearOrchestratorStrategy(
  order: AgentRole[] = DEFAULT_AGENT_EXECUTION_ORDER,
): OrchestratorStrategy {
  return {
    id: 'linear-planner-engineer-reviewer',
    selectRoles(state) {
      const enabled = new Set(state.agents.map((agent) => agent.role));
      return order.filter((role) => enabled.has(role));
    },
  };
}

export const defaultOrchestratorStrategy = createLinearOrchestratorStrategy();
