/** Parse triage agent final message as JSON. Returns null on any failure. */
export function parseTriageJson(result) {
    if (typeof result !== 'string') return null;

    const trimmed = result.trim();
    if (!trimmed) return null;

    const tryParse = (text) => {
        try {
            return JSON.parse(text);
        } catch {
            return null;
        }
    };

    let parsed = tryParse(trimmed);
    if (parsed && typeof parsed === 'object') return parsed;

    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) {
        parsed = tryParse(fenceMatch[1].trim());
        if (parsed && typeof parsed === 'object') return parsed;
    }

    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
        parsed = tryParse(trimmed.slice(start, end + 1));
        if (parsed && typeof parsed === 'object') return parsed;
    }

    return null;
}
