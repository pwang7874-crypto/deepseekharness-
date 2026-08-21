import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
export const name = 'dsh-pet-voice-v2';
export const inject = ['tools', 'settings', 'webServer', 'systemPrompt'];
const Config = z.object({
    token: z.string().role('secret').default('change-me-before-production'),
    completionReminder: z.boolean().default(true),
    allowModelNotifications: z.boolean().default(true),
}).default({ token: 'change-me-before-production', completionReminder: true, allowModelNotifications: true });
const NS = settingsNamespace('petBridge');
class EventHub {
    clients = new Set();
    publish(event) {
        const frame = `event: pet\ndata: ${JSON.stringify(event)}\n\n`;
        for (const client of this.clients)
            client.write(frame);
    }
    attach(res) { this.clients.add(res); return () => this.clients.delete(res); }
}
function sendJson(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(value));
}
/**
 * Emits only presentation events. Keep DSH-version-specific session listeners in
 * a small adapter beside this plugin; the desktop protocol intentionally stays stable.
 */
export function apply(ctx, config) {
    let current = () => config;
    installSettingsSection(ctx, NS, Config, config, { setSource: (source) => { current = source; }, onChange: () => { } });
    const hub = new EventHub();
    let profile = { name: '小深', introduction: '一只陪伴用户工作的智能桌宠', relationship: '朋友', tone: '温柔、自然、简洁' };
    const authorized = (req) => {
        const headerToken = req.headers['x-dsh-pet-token'];
        // EventSource does not permit arbitrary headers; accept its query token only
        // on the loopback web server used by DSH.
        const queryToken = new URL(req.url, 'http://127.0.0.1').searchParams.get('token');
        return headerToken === current().token || queryToken === current().token;
    };
    // dsh-web-server supplies this service at runtime. Keep the cast local until
    // DSH publishes its web-server type augmentation as a standalone peer package.
    const webServer = ctx.webServer;
    webServer.register({ kind: 'exact', path: '/dsh-pet/events', handler: (req, res) => {
            if (!authorized(req))
                return sendJson(res, 401, { error: 'invalid desktop companion token' });
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
            res.write(`event: ready\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
            const detach = hub.attach(res);
            req.on('close', detach);
        } });
    webServer.register({ kind: 'exact', path: '/dsh-pet/profile', handler: async (req, res) => {
            if (!authorized(req))
                return sendJson(res, 401, { error: 'invalid desktop companion token' });
            if (req.method === 'OPTIONS') {
                res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,x-dsh-pet-token' });
                return res.end();
            }
            if (req.method === 'GET')
                return sendJson(res, 200, profile);
            if (req.method !== 'POST')
                return sendJson(res, 405, { error: 'method not allowed' });
            let body = '';
            for await (const chunk of req)
                body += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
            try {
                const next = JSON.parse(body);
                profile = { name: String(next.name || '小深').slice(0, 40), introduction: String(next.introduction || '').slice(0, 1000), relationship: String(next.relationship || '朋友').slice(0, 40), tone: String(next.tone || '自然').slice(0, 200) };
                sendJson(res, 200, profile);
            }
            catch {
                sendJson(res, 400, { error: 'invalid profile JSON' });
            }
        } });
    ctx.systemPrompt.context({
        name: 'dsh-pet:character-profile', order: 35,
        text: () => `桌宠角色设定：你的名字是「${profile.name}」。你与用户的关系是「${profile.relationship}」。人物介绍：${profile.introduction || '未填写'}。对话语气：${profile.tone}。自然地遵循这个设定，不要每次都复述设定，也不要声称现实中具有人类身份。`,
    });
    ctx.tools.register(defineTool({
        name: 'pet_notify',
        description: 'Show an emotional desktop-pet notification. Use only for meaningful task progress, completion, or errors.',
        parameters: {
            text: { type: 'string', required: true, description: 'Short message shown and optionally spoken by the pet.' },
            emotion: { type: 'string', description: 'neutral, thinking, happy, gentle, concerned, or error.' },
            intensity: { type: 'number', description: '0 to 1; default 0.6.' },
            completed: { type: 'boolean', description: 'Set true only when the requested task is fully complete.' },
        },
        output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
        async execute(args) {
            if (!current().allowModelNotifications)
                return 'Desktop-pet notifications are disabled.';
            const emotion = ['neutral', 'thinking', 'happy', 'gentle', 'concerned', 'error'].includes(args.emotion) ? args.emotion : 'neutral';
            const done = Boolean(args.completed);
            hub.publish({ type: done ? 'task-complete' : emotion === 'error' ? 'task-error' : 'state', emotion: done ? 'happy' : emotion, text: args.text.slice(0, 500), intensity: Math.max(0, Math.min(1, Number(args.intensity ?? 0.6))), at: Date.now() });
            return done ? 'Desktop completion reminder sent.' : 'Desktop-pet state sent.';
        },
    }));
    // DSH's stable session event plane drives the default visual lifecycle. We
    // intentionally react only to turn boundaries, so tool/subagent steps remain
    // inside the same task and cannot trigger premature "completed" reminders.
    ctx.on('session/event', (_session, event) => {
        if (event.type === 'turn/start') {
            hub.publish({ type: 'state', emotion: 'thinking', text: '我正在认真处理这件事…', intensity: 0.45, at: Date.now() });
        }
        else if (event.type === 'assistant/chunk') {
            hub.publish({ type: 'state', emotion: 'speaking', intensity: 0.3, at: Date.now() });
        }
        else if (event.type === 'assistant/message') {
            const text = Array.isArray(event.message?.content)
                ? event.message.content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n').trim()
                : '';
            if (text)
                hub.publish({ type: 'state', emotion: 'speaking', text: text.slice(0, 4000), intensity: 0.55, at: Date.now() });
        }
        else if (event.type === 'turn/end') {
            const reason = event.reason?.kind;
            if (reason === 'completed' && current().completionReminder) {
                hub.publish({ type: 'task-complete', emotion: 'happy', text: '任务已经完成啦，来看看结果吧！', intensity: 0.8, at: Date.now() });
            }
            else if (reason === 'error' || reason === 'blocked') {
                hub.publish({ type: 'task-error', emotion: 'error', text: '这项任务遇到了一点问题，需要你看一下。', intensity: 0.7, at: Date.now() });
            }
            else {
                hub.publish({ type: 'state', emotion: 'neutral', intensity: 0.3, at: Date.now() });
            }
        }
    });
    // Other plugins may publish richer emotion metadata without coupling to the
    // desktop protocol.
    ctx.on('dsh-pet/event', (event) => hub.publish(event));
}
