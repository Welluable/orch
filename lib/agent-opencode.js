import { Agent } from './agent.js';
import { normalizeOpencodeToolEvent } from './tool-status.js';

const OPENCODE_DENY_PERMISSION = '{"edit":"deny","bash":"deny"}';

export class AgentOpencode extends Agent {
    #textBuffer = '';
    #sawStepStart = false;

    getSpawnConfig(promptToSend) {
        if (this.readOnly) {
            return {
                command: 'opencode',
                args: ['run', '--format', 'json', '--auto', '--agent', 'plan', promptToSend],
                options: {
                    cwd: this.cwd,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env: { ...process.env, OPENCODE_PERMISSION: OPENCODE_DENY_PERMISSION },
                },
            };
        }

        return {
            command: 'opencode',
            args: ['run', '--format', 'json', '--auto', promptToSend],
            options: {
                cwd: this.cwd,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: process.env,
            },
        };
    }

    handleStreamEvent(event, { verbose, finish }) {
        switch (event.type) {
            case 'step_start': {
                if (!this.#sawStepStart) {
                    this.#sawStepStart = true;
                    this.setStatus('connected');
                } else if (this.activeTools.size === 0) {
                    this.setStatus('thinking…');
                }
                break;
            }
            case 'tool_use': {
                const toolEvent = normalizeOpencodeToolEvent(event);
                if (!toolEvent) break;
                this.onToolEvent({ ...toolEvent, phase: 'started' });
                this.onToolEvent(toolEvent);
                break;
            }
            case 'text': {
                const text = event.part?.text ?? '';
                this.#textBuffer += text;
                if (verbose) {
                    process.stderr.write(text);
                } else if (this.activeTools.size === 0) {
                    this.setStatus('composing response…');
                }
                break;
            }
            case 'step_finish': {
                const reason = event.part?.reason;
                if (reason === 'tool-calls') break;
                if (reason === 'stop' || (reason == null && this.#textBuffer !== '')) {
                    this.settleResult(
                        {
                            is_error: false,
                            result: this.#textBuffer,
                            duration_ms: undefined,
                        },
                        finish,
                    );
                }
                break;
            }
            case 'error': {
                const message =
                    event.error?.data?.message ||
                    event.error?.name ||
                    'OpenCode error';
                this.settleResult(
                    {
                        is_error: true,
                        result: message,
                    },
                    finish,
                );
                break;
            }
            default:
                break;
        }
    }

    handleProcessClose(code, finish) {
        if (code === 0 && this.#textBuffer !== '') {
            this.settleResult(
                {
                    is_error: false,
                    result: this.#textBuffer,
                    duration_ms: undefined,
                },
                finish,
            );
            return;
        }
        super.handleProcessClose(code, finish);
    }
}
