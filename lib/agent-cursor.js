import { Agent, formatToolStatus } from './agent.js';

export class AgentCursor extends Agent {
    getSpawnConfig(promptToSend) {
        return {
            command: 'agent',
            args: ['-p', '--force', '--output-format', 'stream-json', promptToSend],
            options: {
                cwd: process.cwd(),
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
                        if (verbose) {
                            process.stderr.write(event.text ?? '');
                        } else {
                            this.setStatus('thinking…');
                        }
                        break;
                    }
                    case 'completed': {
                        break;
                    }
                }
                break;
            }
            case 'tool_call': {
                this.setStatus(formatToolStatus(event));
                break;
            }
            case 'assistant': {
                this.setStatus('composing response…');
                break;
            }
            case 'result': {
                this.settleResult(event, finish);
                break;
            }
        }
    }
}
