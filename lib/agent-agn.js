import { Agent } from './agent.js';
import { normalizeAgnToolEvent } from './tool-status.js';

export class AgentAgn extends Agent {
    getSpawnConfig(promptToSend) {
        return {
            command: 'agn',
            args: ['-p', '--output-format', 'stream-json', promptToSend],
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
                if (event.subtype === 'init') {
                    this.setStatus('connected');
                }
                break;
            }
            case 'assistant': {
                if (event.subtype === 'delta') {
                    if (this.activeTools.size === 0) {
                        this.startThinking();
                    }
                    if (verbose) {
                        process.stderr.write(event.text ?? '');
                    } else if (this.activeTools.size === 0) {
                        this.setStatus('thinking…');
                    }
                } else if (this.activeTools.size === 0) {
                    this.setStatus('composing response…');
                }
                break;
            }
            case 'tool_call': {
                this.endThinking();
                const toolEvent = normalizeAgnToolEvent(event);
                if (toolEvent) this.onToolEvent(toolEvent);
                break;
            }
            case 'result': {
                this.settleResult(
                    {
                        ...event,
                        result: event.result ?? event.error ?? '',
                        is_error: event.subtype !== 'success',
                    },
                    finish,
                );
                break;
            }
            default:
                break;
        }
    }
}
