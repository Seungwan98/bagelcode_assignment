import { sendMessage, type SendMessageInput } from '@/lib/bus/message-bus';
import type { AgentMessage, AgentRole } from '@/lib/protocol/types';
import { getAgentDefinition, listAgentDefinitions, type AgentDefinition } from '@/lib/runner/agent-definitions';
import { buildAgentPrompt, type AgentPromptContext } from '@/lib/runner/agent-prompt-builder';
import { defaultOrchestratorStrategy, type OrchestratorStrategy } from '@/lib/runner/orchestrator-strategy';

export interface AgentRegistry {
  get(role: AgentRole): AgentDefinition;
  list(roles?: AgentRole[]): AgentDefinition[];
}

export interface AgentPromptBuilder {
  build(definition: AgentDefinition, context: AgentPromptContext): string;
}

export interface AgentMessageBus {
  send(input: SendMessageInput): Promise<AgentMessage>;
}

export interface AgentManagers {
  agentRegistry: AgentRegistry;
  promptBuilder: AgentPromptBuilder;
  messageBus: AgentMessageBus;
  orchestratorStrategy: OrchestratorStrategy;
}

const defaultAgentRegistry: AgentRegistry = {
  get: getAgentDefinition,
  list: listAgentDefinitions,
};

const defaultPromptBuilder: AgentPromptBuilder = {
  build: buildAgentPrompt,
};

const defaultMessageBus: AgentMessageBus = {
  send: sendMessage,
};

export function createAgentManagers(overrides: Partial<AgentManagers> = {}): AgentManagers {
  return {
    agentRegistry: overrides.agentRegistry ?? defaultAgentRegistry,
    promptBuilder: overrides.promptBuilder ?? defaultPromptBuilder,
    messageBus: overrides.messageBus ?? defaultMessageBus,
    orchestratorStrategy: overrides.orchestratorStrategy ?? defaultOrchestratorStrategy,
  };
}
