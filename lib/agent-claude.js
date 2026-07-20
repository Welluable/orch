import { Agent } from './agent.js';
import { normalizeClaudeToolEvent } from './tool-status.js';

export class AgentClaude extends Agent {
    getSpawnConfig(promptToSend) {
        return {
            command: 'claude',
            args: [
                '-p',
                '--output-format',
                'stream-json',
                '--verbose',
                '--dangerously-skip-permissions',
                promptToSend,
            ],
            options: {
                cwd: process.cwd(),
                stdio: ['ignore', 'pipe', 'pipe'],
                env: process.env,
            },
        };
    }

    handleStreamEvent(event, { finish }) {
        switch (event.type) {
            case 'system': {
                if (event.subtype === 'init') {
                    this.setStatus('connected');
                }
                break;
            }
            case 'assistant': {
                const toolEvents = normalizeClaudeToolEvent(event);
                if (toolEvents.length > 0) {
                    toolEvents.forEach((toolEvent) => this.onToolEvent(toolEvent));
                } else if (this.activeTools.size === 0) {
                    this.setStatus('composing response…');
                }
                break;
            }
            case 'user': {
                const toolEvents = normalizeClaudeToolEvent(event);
                toolEvents.forEach((toolEvent) => this.onToolEvent(toolEvent));
                break;
            }
            case 'result': {
                this.settleResult(event, finish);
                break;
            }
            // Ignore rate_limit_event and other non-UI events for v1
            default:
                break;
        }
    }
}
