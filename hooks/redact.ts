/**
 * Removes what looks like a secret from text, before a conversation is saved. BEST EFFORT, and it says so everywhere it
 * is described: it recognises known key formats, connection strings, authorization headers and sensitive names assigned
 * a value. A password typed into a sentence, or a key in a format nobody listed, is not found.
 *
 * This is the client's copy, run before anything leaves the computer. The server runs the same rules again on everything
 * it receives (components/kanban/app/service/secretRedaction.js in codebook-app). Change both together; test/capture.test.tsx
 * here and test/secret-redaction.mjs there hold the same cases.
 *
 * Every pattern is linear on a long input: no nested quantifiers, and every open-ended run has a ceiling.
 */
const mark = (label: string): string => `[removed: ${label}]`;

const TOKEN_RULES: readonly (readonly [string, RegExp])[] = [
    ['private key', /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY[A-Z0-9 ]{0,10}-----[\s\S]{0,20000}?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY[A-Z0-9 ]{0,10}-----|$)/g],
    ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{16,400}/g],
    ['OpenAI key', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,400}/g],
    ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,400}|github_pat_[A-Za-z0-9_]{20,400})/g],
    ['GitLab token', /\bglpat-[A-Za-z0-9_-]{16,200}/g],
    ['Slack token', /\bxox[abeoprs]-[A-Za-z0-9-]{10,400}/g],
    ['Slack webhook', /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{10,200}/g],
    ['AWS key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
    ['Google key', /\bAIza[A-Za-z0-9_-]{30,100}/g],
    ['Google token', /\bya29\.[A-Za-z0-9_-]{20,2000}/g],
    ['Stripe key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,200}/g],
    ['webhook secret', /\bwhsec_[A-Za-z0-9+/=_-]{10,200}/g],
    ['npm token', /\bnpm_[A-Za-z0-9]{30,100}/g],
    ['PyPI token', /\bpypi-[A-Za-z0-9_-]{30,400}/g],
    ['SendGrid key', /\bSG\.[A-Za-z0-9_-]{16,100}\.[A-Za-z0-9_-]{16,100}/g],
    ['JSON web token', /\beyJ[A-Za-z0-9_-]{8,4000}\.eyJ[A-Za-z0-9_-]{8,8000}\.[A-Za-z0-9_-]{8,2000}/g],
    ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/=-]{16,4000}/g],
];

// scheme://user:password@host keeps the scheme and the host, which is what a person reading the conversation needs.
const CONNECTION = /\b([a-z][a-z0-9+.-]{1,30}:\/\/)[^\s:/@'"`\\]{0,200}:[^\s@/'"`\\]{1,400}@/gi;
// Authorization: <anything>, in a header, a curl -H or a config.
const AUTH_HEADER = /\b((?:proxy-)?authorization\\?["']?\s*[:=]\s*\\?["']?\s*)(?:(?:Basic|Token|Bearer)\s+)?[A-Za-z0-9._~+/=:-]{8,4000}/gi;
// A sensitive name given a value: PASSWORD=…, "api_key": "…", client_secret: '…', --password …
const NAME = '[A-Za-z0-9_.-]{0,60}(?:pass(?:word|wd|phrase)|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth[_-]?key|private[_-]?key|encryption[_-]?key|signing[_-]?key|credential|session[_-]?key|_key)[A-Za-z0-9_.-]{0,40}';
const ASSIGNED = new RegExp(`(^|[^A-Za-z0-9_.-])(${NAME})(\\\\?["']?\\s{0,4}(?:=>|:=|=|:|\\s)\\s{0,4})(\\\\?["'\`])?([^\\s"'\`\\\\,;)}\\]]{1,4000}|)(\\\\?["'\`])?`, 'gi');
// What a sensitive name is given and is not a secret: a placeholder, a reference to somewhere else, or a word of code.
const NOT_A_SECRET = /^(?:true|false|null|none|nil|undefined|string|number|boolean|object|any|required|optional|bearer|basic|type|required|\*+|x{3,}|\.{3}|<[^>]*>?|\[.*|\{.*|\$.*|%.*|#.*|process\.env.*|os\.environ.*|env\..*|\w+\(.*|\w+\.\w+.*)$/i;

/** Whether an unquoted value looks like a credential and not a word: it has a digit or symbol, or it is long. */
const tokenLike = (value: string): boolean => value.length >= 20 || (value.length >= 8 && /[0-9]/.test(value) && /[A-Za-z]/.test(value)) || (value.length >= 8 && /[^A-Za-z0-9_.-]/.test(value));

/** `{ text, count }`: `text` with everything shaped like a secret replaced, `count` how many were. */
export function redactSecrets(input: unknown): { text: string; count: number } {
    let text = String(input ?? '');
    let count = 0;
    if (!text) return { text, count };
    for (const [label, pattern] of TOKEN_RULES) {
        text = text.replace(pattern, () => { count++; return mark(label); });
    }
    text = text.replace(CONNECTION, (_: string, scheme: string) => { count++; return `${scheme}${mark('connection string login')}@`; });
    text = text.replace(AUTH_HEADER, (_: string, head: string) => { count++; return `${head}${mark('authorization')}`; });
    text = text.replace(ASSIGNED, (whole: string, before: string, name: string, between: string, open: string | undefined, value: string, close: string | undefined) => {
        if (!value || NOT_A_SECRET.test(value)) return whole;
        if (!open && !tokenLike(value)) return whole;
        if (open && value.length < 4) return whole;
        count++;
        return `${before}${name}${between}${open || ''}${mark(String(name).toLowerCase().slice(0, 40))}${close || ''}`;
    });
    return { text, count };
}

/** Whether a file named in a tool call holds environment secrets: `.env`, `.env.production`; not `.env.example`. */
export function isEnvFile(name: unknown): boolean {
    const base = String(name ?? '').split(/[\\/]/).pop() || '';
    return /^\.env(?:\..+)?$/i.test(base) && !/\.(?:example|sample|template|dist|defaults?)$/i.test(base);
}
