import { Agent, formatToolStatus } from './agent.js';

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
                const content = event.message?.content;
                if (Array.isArray(content)) {
                    const toolUse = content.find((block) => block.type === 'tool_use');
                    if (toolUse) {
                        this.setStatus(formatToolStatus(toolUse));
                        break;
                    }
                }
                this.setStatus('composing response…');
                break;
            }
            case 'result': {
                this.settleResult(event, finish);
                break;
            }
            // Ignore user, rate_limit_event, and other non-UI events for v1
            default:
                break;
        }
    }
}
