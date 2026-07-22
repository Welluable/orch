import { Agent } from './agent.js';
import { normalizeCursorToolEvent } from './tool-status.js';

export class AgentCursor extends Agent {
    getSpawnConfig(promptToSend) {
        return {
            command: 'agent',
            args: ['-p', '--force', '--output-format', 'stream-json', promptToSend],
            options: {
                cwd: this.cwd,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: process.env,
            },
        };
    }

    handleStreamEvent(event, { verbose, finish }) {
        switch (event.type) {
            case 'system': {
                this.setStatus('connected');
                break;
            }
            case 'thinking': {
                switch (event.subtype) {
                    case 'delta': {
                        this.startThinking();
                        if (verbose) {
                            process.stderr.write(event.text ?? '');
                        } else if (this.activeTools.size === 0) {
                            this.setStatus('thinking…');
                        }
                        break;
                    }
                    case 'completed': {
                        this.endThinking();
                        break;
                    }
                }
                break;
            }
            case 'tool_call': {
                this.endThinking();
                const toolEvent = normalizeCursorToolEvent(event);
                if (toolEvent) this.onToolEvent(toolEvent);
                break;
            }
            case 'assistant': {
                this.endThinking();
                if (this.activeTools.size === 0) {
                    this.setStatus('composing response…');
                }
                break;
            }
            case 'result': {
                this.settleResult(event, finish);
                break;
            }
        }
    }
}
