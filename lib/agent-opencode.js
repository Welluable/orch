import { Agent, modelPrintState } from './agent.js';
import { normalizeOpencodeToolEvent } from './tool-status.js';

const OPENCODE_DENY_PERMISSION = '{"edit":"deny","bash":"deny"}';

export class AgentOpencode extends Agent {
    #textBuffer = '';
    #sawStepStart = false;
    #pendingStop = false;
    #settled = false;

    getSpawnConfig(promptToSend) {
        if (this.readOnly) {
            return {
                command: 'opencode',
                args: ['run', '--format', 'json', '--auto', '--thinking', '--agent', 'plan', promptToSend],
                options: {
                    cwd: this.cwd,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env: { ...process.env, OPENCODE_PERMISSION: OPENCODE_DENY_PERMISSION },
                },
            };
        }

        return {
            command: 'opencode',
            args: ['run', '--format', 'json', '--auto', '--thinking', promptToSend],
            options: {
                cwd: this.cwd,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: process.env,
            },
        };
    }

    #printModelOnce(modelId) {
        if (modelPrintState.printed || typeof modelId !== 'string' || !modelId) return;
        modelPrintState.printed = true;
        const wasSpinning = this.spinner?.isSpinning;
        if (wasSpinning) this.spinner.stop?.();
        console.log(`model: ${modelId}`);
        if (wasSpinning) this.spinner.start?.();
    }

    #printUsageLine(part) {
        const tokens = part?.tokens;
        if (!tokens || typeof tokens !== 'object') return;
        const input = tokens.input ?? tokens.in;
        const output = tokens.output ?? tokens.out;
        if (typeof input !== 'number' && typeof output !== 'number') return;

        let line = `  tokens: in=${input ?? 0} out=${output ?? 0}`;
        const cost = part.cost;
        if (typeof cost === 'number' && cost > 0) {
            line += ` · cost=$${cost}`;
        }
        process.stderr.write(`${line}\n`);
    }

    #settleOk(finish, { verbose = false, part = null } = {}) {
        if (this.#settled) return;
        this.#settled = true;
        this.#pendingStop = false;
        this.settleResult(
            {
                is_error: false,
                result: this.#textBuffer,
                duration_ms: undefined,
            },
            finish,
        );
        if (verbose && part) this.#printUsageLine(part);
    }

    #recordApplyPatchFiles(toolEvent) {
        if (toolEvent.name !== 'apply_patch' || !this.fileTracker) return;
        const entries = this.fileTracker.recordApplyPatch(toolEvent.args?.patchText);
        for (const entry of entries) {
            if (!entry.isNew) continue;
            const wasSpinning = this.spinner?.isSpinning;
            if (wasSpinning) this.spinner.stop();
            console.log(`  ${entry.marker} ${entry.path}`);
            if (wasSpinning) this.spinner.start();
            this.onFileChange?.(entry);
        }
    }

    handleStreamEvent(event, { verbose, finish }) {
        switch (event.type) {
            case 'message.updated': {
                this.#printModelOnce(event.properties?.info?.modelID);
                break;
            }
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
                this.#recordApplyPatchFiles(toolEvent);
                break;
            }
            case 'reasoning': {
                const text = event.part?.text ?? '';
                if (verbose) {
                    process.stderr.write(text);
                } else if (this.activeTools.size === 0) {
                    this.setStatus('thinking…');
                }
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
                if (this.#pendingStop && this.#textBuffer !== '') {
                    this.#settleOk(finish, { verbose });
                }
                break;
            }
            case 'step_finish': {
                const reason = event.part?.reason;
                if (reason === 'tool-calls') break;
                if (reason === 'stop' || reason == null) {
                    if (this.#textBuffer !== '') {
                        this.#settleOk(finish, { verbose, part: event.part });
                    } else {
                        this.#pendingStop = true;
                    }
                }
                break;
            }
            case 'error': {
                if (this.#settled) break;
                this.#settled = true;
                this.#pendingStop = false;
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
        if (this.#settled) return;
        if (code === 0 && this.#textBuffer !== '') {
            this.#settleOk(finish);
            return;
        }
        super.handleProcessClose(code, finish);
    }
}
