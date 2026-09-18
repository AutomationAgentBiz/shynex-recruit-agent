// Shynex House Cleaning - Spanish SMS recruiting assistant (Quo / OpenPhone)
// v2 - Sept 2026
//
// Rules:
//  - Replies ONLY on the Primary line, ONLY in Spanish, ONLY to people asking about the house cleaning job.
//  - Never starts a conversation. Never replies to blocked numbers, saved contacts listed in BLOCKED_NUMBERS,
//    our own lines, English messages, customers, sign jobs, other jobs or spam.
//  - Goes silent for a person as soon as Pete (a human) texts them from the Quo app.
//  - Conversation state is saved in Redis (Render Key Value) when REDIS_URL is set, so restarts do not wipe it.

var express = require('express');
var axios = require('axios');

var app = express();
app.use(express.json({ limit: '1mb' }));

// ───────────────────────── CONFIG ─────────────────────────
var CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
var OPENPHONE_API_KEY = process.env.OPENPHONE_API_KEY;
var CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

var PRIMARY_NUMBER = process.env.PRIMARY_NUMBER || '+19704758540';     // the ONLY line the bot answers on
var PRIMARY_PHONE_ID = process.env.PRIMARY_PHONE_ID || 'PNEQYQtOSU';
var ALERT_NUMBER = process.env.ALERT_NUMBER || '+19706463345';         // Pete's cell - receives alerts, can send admin commands
var OWN_NUMBERS = listFromEnv(process.env.OWN_NUMBERS, ['+19704442779', '+19704758540', '+19704447789']);
var TEST_NUMBERS = listFromEnv(process.env.TEST_NUMBERS, ['+19704447789', '+19706463345']);
var BLOCKED_NUMBERS = listFromEnv(process.env.BLOCKED_NUMBERS, []);
var BOT_ENABLED_DEFAULT = String(process.env.BOT_ENABLED || 'true').toLowerCase() !== 'false';
var TIMEZONE = 'America/Denver';
var RESET_KEYWORD = 'SHYNEXRESET';
var TIME_KEYWORD = 'SHYNEXTIME';

// Current job the bot is recruiting for. The street address is intentionally NOT here - the bot never shares it.
var JOB = {
    activeUntil: '2026-09-21T12:00:00-06:00',
    dateEs: 'lunes 21 de septiembre',
    dayBeforeEs: 'domingo 20 de septiembre',
    dayBeforeDate: '2026-09-20',
    city: 'Fort Collins',
    type: 'limpieza de mudanza (move-out), casa grande ya vacía',
    arrive: '8:00 am en Fort Collins',
    hours: 'aproximadamente 6 a 7 horas',
    people: '2 personas',
    pay: '$50 la hora por las 2 personas (o sea $25 la hora cada una) - es el pago del primer trabajo de prueba, porque es la primera vez que trabajamos juntos',
    meetup: 'a las 6:30 am en el Safeway de 3550 W 10th St, Greeley (en la gasolinera/estacionamiento) para darles las camisas del uniforme; de ahí manejan a Fort Collins para llegar a las 8:00 am',
    supplies: 'cada quien trae sus propios productos y equipo de limpieza (incluyendo aspiradora)'
};

function listFromEnv(v, fallback) {
    if (!v) return fallback.map(normalizePhone);
    return String(v).split(/[,\s]+/).filter(Boolean).map(normalizePhone);
}

function normalizePhone(raw) {
    var digits = String(raw || '').replace(/[^0-9]/g, '');
    if (digits.length > 10) digits = digits.slice(digits.length - 10);
    return digits;
}

function inList(list, phone) {
    return list.indexOf(normalizePhone(phone)) !== -1;
}

// ───────────────────────── STORAGE ─────────────────────────
// Redis when REDIS_URL is set (survives restarts), otherwise memory.
var redis = null;
var memStore = {};
if (process.env.REDIS_URL) {
    try {
        var Redis = require('ioredis');
        redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3 });
        redis.on('error', function(e) { console.error('Redis error:', e.message); });
        console.log('Using Redis for state');
    } catch (e) {
        console.error('ioredis not available, using memory:', e.message);
        redis = null;
    }
}

async function kvGet(key) {
    if (redis) {
        var v = await redis.get('shx:' + key);
        return v ? JSON.parse(v) : null;
    }
    return memStore[key] ? JSON.parse(memStore[key]) : null;
}

async function kvSet(key, value, ttlSeconds) {
    var s = JSON.stringify(value);
    if (redis) {
        if (ttlSeconds) await redis.set('shx:' + key, s, 'EX', ttlSeconds);
        else await redis.set('shx:' + key, s);
        return;
    }
    memStore[key] = s;
}

async function kvDel(key) {
    if (redis) { await redis.del('shx:' + key); return; }
    delete memStore[key];
}

async function kvKeys(prefix) {
    if (redis) {
        var keys = await redis.keys('shx:' + prefix + '*');
        return keys.map(function(k) { return k.slice(4); });
    }
    return Object.keys(memStore).filter(function(k) { return k.indexOf(prefix) === 0; });
}

async function isBotEnabled() {
    var v = await kvGet('config:enabled');
    if (v === null || v === undefined) return BOT_ENABLED_DEFAULT;
    return !!v;
}

async function isBlocked(phone) {
    if (inList(BLOCKED_NUMBERS, phone)) return true;
    var extra = await kvGet('blocked:' + normalizePhone(phone));
    return !!extra;
}

function newState(phone) {
    return {
        phone: phone,
        stage: 'new',            // new | gate | screening | waitlist | call_pending | ignored | declined
        history: [],             // [{role, content}] Spanish conversation for the AI
        profile: {},             // name, city, experience, car, supplies, helper, available, accepted_pay, best_time
        human: false,            // true once Pete texts this person himself
        alerts: {},
        ignoredMsgs: 0,
        confirmed: false,
        test: false,
        fakeNow: null,
        createdAt: new Date().toISOString(),
        lastAt: new Date().toISOString()
    };
}

async function loadState(phone) {
    return (await kvGet('conv:' + normalizePhone(phone))) || newState(phone);
}

async function saveState(state) {
    state.lastAt = new Date().toISOString();
    if (state.history.length > 60) state.history = state.history.slice(state.history.length - 60);
    await kvSet('conv:' + normalizePhone(state.phone), state, 60 * 60 * 24 * 120);
}

// One message at a time per phone number (prevents double replies when people send 2 texts fast)
var locks = {};
function withLock(phone, fn) {
    var key = normalizePhone(phone);
    var prev = locks[key] || Promise.resolve();
    var next = prev.then(fn, fn).catch(function(e) { console.error('Handler error:', e && e.stack || e); });
    locks[key] = next;
    next.then(function() { if (locks[key] === next) delete locks[key]; });
    return next;
}

// ───────────────────────── TIME HELPERS ─────────────────────────
function denverParts(date) {
    var fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: TIMEZONE, weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
    });
    var parts = {};
    fmt.formatToParts(date).forEach(function(p) { parts[p.type] = p.value; });
    var hour = parseInt(parts.hour, 10) % 24;
    return {
        weekday: parts.weekday,                       // Monday..Sunday
        date: parts.year + '-' + parts.month + '-' + parts.day,
        hour: hour,
        minute: parseInt(parts.minute, 10)
    };
}

var DIAS = { Monday: 'lunes', Tuesday: 'martes', Wednesday: 'miércoles', Thursday: 'jueves', Friday: 'viernes', Saturday: 'sábado', Sunday: 'domingo' };
var NEXT_DAY = { Monday: 'Tuesday', Tuesday: 'Wednesday', Wednesday: 'Thursday', Thursday: 'Friday', Friday: 'Saturday', Saturday: 'Sunday', Sunday: 'Monday' };

function nowFor(state) {
    if (state && state.fakeNow) return new Date(state.fakeNow);
    return new Date();
}

function jobIsActive(now) {
    return now.getTime() < new Date(JOB.activeUntil).getTime();
}

// Pete's rule for when he will call:
//  - Friday (any time): tomorrow Saturday before 5 pm
//  - Other days: before 3 pm -> today before 5 pm; after 3 pm -> tomorrow before 5 pm
//  - Sunday after 3 pm while the Monday job is open: today as soon as possible + urgent alert
function callWindow(now) {
    var p = denverParts(now);
    var early = p.hour < 15;
    if (p.weekday === 'Friday') {
        return { es: 'mañana sábado antes de las 5 pm', label: 'Saturday before 5 PM', urgent: false };
    }
    if (early) {
        return { es: 'hoy ' + DIAS[p.weekday] + ' antes de las 5 pm', label: 'today (' + p.weekday + ') before 5 PM', urgent: p.weekday === 'Sunday' };
    }
    if (p.weekday === 'Sunday' && p.date === JOB.dayBeforeDate) {
        return { es: 'hoy mismo en cuanto pueda (hoy por la tarde/noche)', label: 'TODAY ASAP (job is tomorrow)', urgent: true };
    }
    var next = NEXT_DAY[p.weekday];
    return { es: 'mañana ' + DIAS[next] + ' antes de las 5 pm', label: next + ' before 5 PM', urgent: false };
}

function nowDescriptionEs(now) {
    var p = denverParts(now);
    return DIAS[p.weekday] + ' ' + p.date + ', ' + String(p.hour).padStart(2, '0') + ':' + String(p.minute).padStart(2, '0') + ' (hora de Colorado)';
}

// ───────────────────────── QUO / OPENPHONE ─────────────────────────
async function sendSms(to, content, opts) {
    opts = opts || {};
    try {
        var res = await axios.post('https://api.openphone.com/v1/messages', {
            content: content,
            from: PRIMARY_NUMBER,
            to: [to]
        }, {
            headers: { 'Authorization': OPENPHONE_API_KEY, 'Content-Type': 'application/json' },
            timeout: 20000
        });
        var id = res.data && res.data.data && res.data.data.id;
        if (id) await kvSet('botmsg:' + id, 1, 60 * 60 * 24 * 7);
        // Also remember recent bot texts per recipient (backup check for the human-takeover detection)
        var recentKey = 'botrecent:' + normalizePhone(to);
        var recent = (await kvGet(recentKey)) || [];
        recent.push(textKey(content));
        if (recent.length > 20) recent = recent.slice(recent.length - 20);
        await kvSet(recentKey, recent, 60 * 60 * 24 * 7);
        console.log('SMS sent to ' + to + (opts.alert ? ' (alert)' : ''));
        return true;
    } catch (error) {
        var msg = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error('OpenPhone send error:', msg);
        return false;
    }
}

function textKey(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

async function sendAlert(state, title, lines) {
    var msg = (state && state.test ? '[TEST] ' : '') + title + '\n' + lines.filter(Boolean).join('\n');
    return sendSms(ALERT_NUMBER, msg, { alert: true });
}

// ───────────────────────── CLAUDE ─────────────────────────
async function callClaude(system, messages, maxTokens) {
    var res = await axios.post('https://api.anthropic.com/v1/messages', {
        model: CLAUDE_MODEL,
        max_tokens: maxTokens || 700,
        system: system,
        messages: messages
    }, {
        headers: { 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        timeout: 45000
    });
    return res.data.content.map(function(c) { return c.text || ''; }).join('');
}

function parseJson(text) {
    if (!text) return null;
    var start = text.indexOf('{');
    var end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    try { return JSON.parse(text.slice(start, end + 1)); } catch (e) { return null; }
}

// Classifier: decides if we are allowed to reply at all.
var CLASSIFIER_PROMPT =
"You are a strict gatekeeper for the SMS line of Shynex House Cleaning (a house cleaning company in Northern Colorado). " +
"The company has posted Spanish-language ads looking for house cleaners (contractors). A separate assistant may ONLY reply to people who are " +
"writing IN SPANISH about the HOUSE CLEANING JOB (wanting to work cleaning houses for the company).\n\n" +
"Classify the latest message(s) and return ONLY a JSON object:\n" +
"{\"language\": \"es\" | \"en\" | \"mixed\" | \"unknown\", \"intent\": \"cleaning_job\" | \"greeting_only\" | \"yes_cleaning\" | \"sign_job\" | \"other_job\" | \"customer\" | \"existing_worker\" | \"spam\" | \"other\", \"reason\": \"short\"}\n\n" +
"Definitions:\n" +
"- cleaning_job: clearly asking about working cleaning houses / the cleaning job / 'trabajo de limpieza' / saw the ad and wants the job.\n" +
"- greeting_only: only a greeting or vague opener with no topic (e.g. 'Hola', 'Buenas tardes', 'Hola, me interesa' with no topic, 'Información').\n" +
"- yes_cleaning: an answer confirming they are writing about the cleaning job (e.g. 'Sí', 'Si, por el trabajo', 'Así es').\n" +
"- sign_job: anything about placing/picking up signs, yard signs, letreros, rótulos.\n" +
"- other_job: any other job (construction, painting, landscaping, drivers, etc.).\n" +
"- customer: someone who wants to HIRE a cleaning (a client asking prices, quotes, booking, their appointment).\n" +
"- existing_worker: someone who already works with the company talking about current jobs, schedules, payments, shirts, addresses of houses.\n" +
"- spam/other: anything else.\n" +
"language: 'es' only if the message is written in Spanish. English messages are 'en' even if they mention cleaning. A few English words inside a Spanish message is still 'es'.";

async function classify(texts, context) {
    var content = (context ? 'Context: ' + context + '\n\n' : '') + 'Message(s):\n' + texts.map(function(t) { return '- ' + t; }).join('\n');
    try {
        var out = await callClaude(CLASSIFIER_PROMPT, [{ role: 'user', content: content }], 200);
        var j = parseJson(out);
        if (j && j.intent) return j;
    } catch (e) {
        console.error('Classifier error:', e.response ? JSON.stringify(e.response.data) : e.message);
    }
    return { language: 'unknown', intent: 'other', reason: 'classifier failed' };
}

// Main Spanish screening assistant
function buildScreeningPrompt(state, now) {
    var win = callWindow(now);
    var active = jobIsActive(now);
    var prof = state.profile || {};

    var jobBlock = active ?
        ("EL TRABAJO ACTUAL (para el que estamos buscando gente):\n" +
        "- Día: " + JOB.dateEs + ", llegar a las " + JOB.arrive + ".\n" +
        "- Tipo: " + JOB.type + ". Duración: " + JOB.hours + ". Se necesitan " + JOB.people + " (si la persona tiene ayudante, perfecto; si no, está bien, la podemos juntar con otra persona).\n" +
        "- Pago: " + JOB.pay + ". Se paga el mismo día al terminar el trabajo (después de regresar las camisas). Si el trabajo necesita más tiempo, se avisa antes y solo se paga tiempo extra si se aprueba.\n" +
        "- Productos: " + JOB.supplies + ".\n" +
        "- Camisas y punto de encuentro (solo si la contratan): el " + JOB.dateEs + " " + JOB.meetup + ".\n" +
        "- Nadie queda contratado por mensaje de texto. Pedro decide después de la llamada. Si la contratan, un día antes (" + JOB.dayBeforeEs + ") tiene que confirmar por mensaje que sí va; si no confirma, el trabajo se le da a otra persona.\n" +
        "- NUNCA des la dirección de la casa. La dirección se da después, solo a las personas aprobadas.\n") :
        ("No hay un trabajo específico abierto ahorita. Di que abrimos trabajos cada semana y que Pedro le explica en la llamada cuándo sería el primer trabajo. " +
        "El primer trabajo siempre es de prueba (1 casa) para ver calidad y comunicación.\n");

    return (
"Eres la persona que contesta los mensajes de texto de reclutamiento de Shynex House Cleaning, una compañía de limpieza de casas en el norte de Colorado (Greeley, Fort Collins, Loveland, Windsor). " +
"Le ayudas a Pedro, el encargado, a encontrar limpiadoras. Escribes SIEMPRE en español, de forma natural, cálida y breve, como una persona real mandando mensajes de texto (tú, no usted, salvo que la persona use usted). " +
"Nada de listas largas, nada de sonar a robot, nada de negritas ni asteriscos. Máximo 1 a 3 oraciones cortas por mensaje, y UNA sola pregunta por mensaje. Emojis: casi nunca (máximo uno de vez en cuando).\n\n" +

"FECHA Y HORA AHORA: " + nowDescriptionEs(now) + ".\n\n" +

jobBlock + "\n" +

"CÓMO FUNCIONA SHYNEX (usa esto para contestar preguntas; no lo sueltes todo de golpe):\n" +
"- Es trabajo como contratista independiente (tú eres tu propia jefa). Se paga por casa (precio fijo por casa); normalmente sale entre $25 y $35 la hora aproximadamente, dependiendo del récord de cada persona. El primer trabajo es de prueba con el pago indicado arriba.\n" +
"- Después del primer trabajo, si todo sale bien, se van dando más casas: 2 o 3 la siguiente semana y luego más. Hay casas de mudanza y casas habitadas (semanales, cada 2 semanas, mensuales).\n" +
"- Cada quien trae sus propios productos, aspiradora y transporte. Si trae ayudante, cómo le paga a su ayudante es decisión de ella.\n" +
"- Se toman fotos de antes y después en cada casa y se mandan por WhatsApp. En el primer trabajo Pedro se comunica cada 1 o 2 horas.\n" +
"- Horario general de trabajo: más o menos de 7 am a 5 pm.\n" +
"- Es una compañía real: página web shynexclean.com y en Facebook como Shynex House Cleaning. Se conocen en persona antes del primer trabajo.\n" +
"- Temas como contrato, seguro, impuestos/1099, papeles o permisos de trabajo: NO preguntes por eso y no des detalles; di amablemente que Pedro lo platica en la llamada.\n" +
"- Si preguntan si eres un robot o una persona: sé honesta, di que eres una asistente que le ayuda a Pedro con los mensajes y que él mismo les va a llamar.\n" +
"- Si preguntan algo que no sabes, di que Pedro se lo explica en la llamada. No inventes datos.\n\n" +

"LO QUE NECESITAS SABER DE LA PERSONA (pregunta de uno en uno, en este orden, saltando lo que ya dijo):\n" +
"1. Nombre.\n" +
"2. En qué ciudad vive.\n" +
"3. Experiencia limpiando casas (cuánto tiempo y de qué tipo: casas habitadas, mudanzas, oficinas).\n" +
"4. Si tiene carro/transporte propio.\n" +
"5. Si tiene sus propios productos de limpieza y aspiradora.\n" +
"6. Si tiene alguien que le ayude (no es obligatorio).\n" +
(active ? "7. Si puede trabajar el " + JOB.dateEs + " (llegar a Fort Collins a las 8 am).\n" +
"8. Explícale brevemente el trabajo y deja MUY claro el pago de prueba: $25 la hora cada persona ($50 la hora las dos), porque es el primer trabajo juntos. Pregunta si está de acuerdo con ese pago.\n" +
"8b. Pregunta, dejando claro que es SOLO si la contratan (todavía no está contratada ni confirmada): si la contratan, ¿puede verse ese día a las 6:30 am en el Safeway de 3550 W 10th St en Greeley para recoger las camisas del uniforme antes de irse a Fort Collins?\n" : "") +
"9. Pregúntale si está bien que Pedro le llame " + win.es + " para una llamada rápida de 5 a 10 minutos, y a qué hora le queda mejor. NO agendes una cita exacta; solo anota la hora que prefiere. Nunca ofrezcas otro día que no sea: " + win.es + ".\n" +
"10. Cuando te dé la hora, cierra con un mensaje corto: que Pedro le llama " + win.es + " cerca de esa hora, " +
(active ? "y que si la contratan después de la llamada, Pedro le confirma los detalles, y un día antes (" + JOB.dayBeforeEs + ") tendría que confirmar por aquí que sí va. No digas que ya está contratada ni confirmada. " : "") +
"Algo así de natural, no como formulario.\n\n" +

"CUÁNDO NO SIGUE:\n" +
"- Si no tiene transporte propio o no tiene sus propios productos: pregunta una vez para confirmar (por si se equivocó). Si lo confirma, dile amablemente que por ahora se necesita eso para este trabajo y que la guardamos en la lista para más adelante. status = waitlist.\n" +
(active ? "- Si no puede el " + JOB.dateEs + ": dile que no hay problema, que la guardamos en la lista para los próximos trabajos, y aun así pregunta si está bien que Pedro le llame para conocerla (paso 9). Si no quiere, status = waitlist.\n" : "") +
"- Si no acepta el pago de prueba: sé amable, di que así es el primer trabajo para todos y que la guardamos en la lista. status = waitlist.\n" +
"- Si es grosera o dice que no le interesa: despídete breve. status = not_interested.\n" +
"- Si la conversación se va a otro tema que no es el trabajo de limpieza (por ejemplo letreros, otro trabajo, o quiere contratar una limpieza), no contestes nada: reply = \"\" y status = off_topic.\n\n" +

"DATOS QUE YA TENEMOS DE ESTA PERSONA: " + JSON.stringify(prof) + "\n\n" +

"FORMATO DE RESPUESTA: devuelve SOLO un objeto JSON, sin texto antes o después:\n" +
"{\"reply\": \"mensaje en español para mandar (o \\\"\\\" si no hay que contestar)\", " +
"\"profile\": {\"name\": null, \"city\": null, \"experience\": null, \"car\": null, \"supplies\": null, \"helper\": null, \"available_job\": null, \"accepted_pay\": null, \"meetup_ok\": null, \"best_time\": null}, " +
"\"status\": \"continue\" | \"call_ready\" | \"waitlist\" | \"not_interested\" | \"off_topic\"}\n" +
"En profile llena solo lo que la persona ya dijo (texto corto o true/false), deja null lo demás. " +
"status = call_ready SOLO cuando ya aceptó que Pedro le llame y ya dio la hora que prefiere (best_time)."
    );
}

// ───────────────────────── MESSAGE HANDLING ─────────────────────────
async function handleIncoming(from, text, msgId) {
    var state = await loadState(from);
    state.test = inList(TEST_NUMBERS, from);
    var trimmed = String(text || '').trim();
    var upper = trimmed.toUpperCase();

    // Test-only commands
    if (state.test && upper === RESET_KEYWORD) {
        await kvDel('conv:' + normalizePhone(from));
        await sendSms(from, 'Reset listo.');
        return;
    }
    if (state.test && upper.indexOf(TIME_KEYWORD) === 0) {
        var arg = trimmed.slice(TIME_KEYWORD.length).trim();
        state.fakeNow = (!arg || arg.toLowerCase() === 'off') ? null : new Date(arg).toISOString();
        await saveState(state);
        await sendSms(from, 'Hora de prueba: ' + (state.fakeNow ? nowDescriptionEs(new Date(state.fakeNow)) : 'real'));
        return;
    }

    if (state.human) { console.log('Human handling ' + from + ', bot silent'); return; }
    if (state.stage === 'declined') return;

    var now = nowFor(state);

    // CONFIRMO on the day before / any time after screening
    if (/^\s*confirm[oó]/i.test(trimmed) && (state.stage === 'call_pending' || state.stage === 'screening')) {
        state.confirmed = true;
        state.history.push({ role: 'user', content: trimmed });
        var ok = jobIsActive(now) ?
            '¡Gracias por confirmar! Nos vemos el ' + JOB.dateEs + ' a las 6:30 am en el Safeway de 3550 W 10th St en Greeley. Cualquier cambio, Pedro te avisa.' :
            '¡Gracias por confirmar!';
        state.history.push({ role: 'assistant', content: ok });
        await saveState(state);
        await sendSms(from, ok);
        await sendAlert(state, 'CONFIRMÓ ✅', ['Name: ' + (state.profile.name || '?'), 'Phone: ' + from]);
        return;
    }

    // Gatekeeping for people who are not in an active screening yet
    if (state.stage === 'new' || state.stage === 'ignored' || state.stage === 'gate') {
        var c = await classify([trimmed], state.stage === 'gate' ?
            'We previously asked this person: "¿Nos escribes por el trabajo de limpieza de casas?"' : null);
        console.log('Classify ' + from + ': ' + JSON.stringify(c));

        var spanish = c.language === 'es';
        if (spanish && (c.intent === 'cleaning_job' || (state.stage === 'gate' && c.intent === 'yes_cleaning'))) {
            state.stage = 'screening';
            // fall through to screening below
        } else if (spanish && c.intent === 'greeting_only' && state.stage === 'new') {
            state.stage = 'gate';
            var q = '¡Hola! ¿Nos escribes por el trabajo de limpieza de casas?';
            state.history.push({ role: 'user', content: trimmed });
            state.history.push({ role: 'assistant', content: q });
            await saveState(state);
            await sendSms(from, q);
            return;
        } else {
            // Not allowed to reply. Stay silent.
            var wasNew = state.stage === 'new';
            state.stage = 'ignored';
            state.ignoredMsgs = (state.ignoredMsgs || 0) + 1;
            await saveState(state);
            if (wasNew && c.intent === 'customer' && !state.alerts.customer) {
                state.alerts.customer = true; await saveState(state);
                await sendAlert(state, 'FYI: posible CLIENTE escribió al Primary (bot no contestó)', ['Phone: ' + from, 'Msg: ' + trimmed.slice(0, 160)]);
            }
            if (wasNew && c.language === 'en' && c.intent === 'cleaning_job' && !state.alerts.english) {
                state.alerts.english = true; await saveState(state);
                await sendAlert(state, 'FYI: aplicante en INGLÉS (bot no contestó)', ['Phone: ' + from, 'Msg: ' + trimmed.slice(0, 160)]);
            }
            return;
        }
    }

    if (state.stage === 'waitlist' || state.stage === 'screening' || state.stage === 'call_pending') {
        await runScreening(state, trimmed, now);
    }
}

async function runScreening(state, text, now) {
    state.history.push({ role: 'user', content: text });
    var msgs = mergeRoles(state.history);
    var out;
    try {
        out = await callClaude(buildScreeningPrompt(state, now), msgs, 700);
    } catch (e) {
        console.error('Claude error:', e.response ? JSON.stringify(e.response.data) : e.message);
        state.history.pop();
        await saveState(state);
        if (!state.alerts.aiError) {
            state.alerts.aiError = true; await saveState(state);
            await sendAlert(state, 'BOT ERROR: la IA no respondió', ['Phone: ' + state.phone, 'Msg: ' + text.slice(0, 120)]);
        }
        return;
    }
    var j = parseJson(out);
    if (!j) {
        console.error('Bad JSON from Claude:', out.slice(0, 300));
        state.history.pop();
        await saveState(state);
        return;
    }

    // merge profile
    var p = j.profile || {};
    Object.keys(p).forEach(function(k) {
        if (p[k] !== null && p[k] !== undefined && p[k] !== '') state.profile[k] = p[k];
    });

    var reply = String(j.reply || '').replace(/\*\*/g, '').trim();
    var status = j.status || 'continue';

    if (status === 'off_topic') {
        state.history.pop();
        await saveState(state);
        console.log('Off topic from ' + state.phone + ', no reply');
        return;
    }

    if (reply) state.history.push({ role: 'assistant', content: reply });
    else state.history.pop();

    var prevStage = state.stage;
    if (status === 'waitlist') state.stage = 'waitlist';
    if (status === 'not_interested') state.stage = 'declined';
    if (status === 'call_ready') state.stage = 'call_pending';
    await saveState(state);

    if (reply) await sendSms(state.phone, reply);

    var prof = state.profile;
    var win = callWindow(now);
    if (status === 'call_ready' && !state.alerts.callReady) {
        state.alerts.callReady = true;
        await saveState(state);
        await sendAlert(state, (win.urgent ? '🚨 URGENTE - ' : '') + 'CANDIDATA LISTA PARA LLAMADA', [
            'Name: ' + (prof.name || '?') + ' | City: ' + (prof.city || '?'),
            'Phone: ' + state.phone,
            'Call: ' + win.label + ' | Best time: ' + (prof.best_time || '?'),
            'Monday: ' + fmtBool(prof.available_job) + ' | OK $25/hr: ' + fmtBool(prof.accepted_pay) + ' | 6:30 meet OK: ' + fmtBool(prof.meetup_ok),
            'Car: ' + fmtBool(prof.car) + ' | Supplies: ' + fmtBool(prof.supplies) + ' | Helper: ' + fmtBool(prof.helper),
            prof.experience ? 'Exp: ' + String(prof.experience).slice(0, 80) : null
        ]);
    }
    if (status === 'waitlist' && prevStage !== 'waitlist' && !state.alerts.waitlist) {
        state.alerts.waitlist = true;
        await saveState(state);
        await sendAlert(state, 'Waitlist (no calificó para este trabajo)', [
            'Name: ' + (prof.name || '?') + ' | City: ' + (prof.city || '?'),
            'Phone: ' + state.phone,
            'Car: ' + fmtBool(prof.car) + ' | Supplies: ' + fmtBool(prof.supplies) + ' | Monday: ' + fmtBool(prof.available_job)
        ]);
    }
}

function fmtBool(v) {
    if (v === true) return 'yes';
    if (v === false) return 'NO';
    if (v === null || v === undefined) return '?';
    return String(v).slice(0, 40);
}

// Claude requires alternating roles starting with user
function mergeRoles(history) {
    var out = [];
    history.forEach(function(m) {
        if (out.length && out[out.length - 1].role === m.role) {
            out[out.length - 1].content += '\n' + m.content;
        } else {
            out.push({ role: m.role, content: m.content });
        }
    });
    while (out.length && out[0].role !== 'user') out.shift();
    return out;
}

function isAdminCommand(text) {
    return /^\s*(BOT (ON|OFF)|PAUSA|PAUSE|SEGUIR|RESUME|BLOQUEAR|BLOCK)\b/i.test(String(text || ''));
}

// Admin commands from Pete's cell (texting the Primary line)
async function handleAdmin(text) {
    var t = String(text || '').trim();
    var u = t.toUpperCase();
    var m;
    if (u === 'BOT OFF') { await kvSet('config:enabled', false); return sendSms(ALERT_NUMBER, 'Bot APAGADO. Manda BOT ON para prenderlo.', { alert: true }); }
    if (u === 'BOT ON') { await kvSet('config:enabled', true); return sendSms(ALERT_NUMBER, 'Bot PRENDIDO.', { alert: true }); }
    if ((m = u.match(/^(PAUSA|PAUSE)\s+(.+)$/))) {
        var st = await loadState(m[2]); st.human = true; await saveState(st);
        return sendSms(ALERT_NUMBER, 'Bot en pausa para ' + m[2].trim(), { alert: true });
    }
    if ((m = u.match(/^(SEGUIR|RESUME)\s+(.+)$/))) {
        var st2 = await loadState(m[2]); st2.human = false; await saveState(st2);
        return sendSms(ALERT_NUMBER, 'Bot activo otra vez para ' + m[2].trim(), { alert: true });
    }
    if ((m = u.match(/^(BLOQUEAR|BLOCK)\s+(.+)$/))) {
        await kvSet('blocked:' + normalizePhone(m[2]), true);
        return sendSms(ALERT_NUMBER, 'Bloqueado: ' + m[2].trim(), { alert: true });
    }
    // Anything else from Pete's cell is ignored (no reply)
}

// ───────────────────────── WEBHOOK ─────────────────────────
var seen = {};
function alreadySeen(id) {
    if (!id) return false;
    if (seen[id]) return true;
    seen[id] = Date.now();
    var keys = Object.keys(seen);
    if (keys.length > 2000) keys.slice(0, 500).forEach(function(k) { delete seen[k]; });
    return false;
}

function isForPrimary(obj) {
    if (obj.phoneNumberId) return obj.phoneNumberId === PRIMARY_PHONE_ID;
    var to = Array.isArray(obj.to) ? obj.to : [obj.to];
    return to.some(function(n) { return normalizePhone(n) === normalizePhone(PRIMARY_NUMBER); });
}

app.post('/webhook', function(req, res) {
    res.status(200).json({ received: true });
    var body = req.body || {};
    var obj = body.data && body.data.object;
    if (!obj) return;

    // Outgoing message delivered: if a human (not the bot) sent it from the Primary line, the bot goes silent for that person.
    if (body.type === 'message.delivered') {
        if (!isForPrimaryOutgoing(obj)) return;
        var recipient = Array.isArray(obj.to) ? obj.to[0] : obj.to;
        if (!recipient || normalizePhone(recipient) === normalizePhone(ALERT_NUMBER)) return;
        withLock(recipient, async function() {
            var isBot = obj.id && (await kvGet('botmsg:' + obj.id));
            if (!isBot) {
                var recent = (await kvGet('botrecent:' + normalizePhone(recipient))) || [];
                isBot = recent.indexOf(textKey(obj.body || obj.text || obj.content)) !== -1;
            }
            if (isBot) return;
            var st = await loadState(recipient);
            if (!st.human) {
                st.human = true;
                await saveState(st);
                console.log('Human took over conversation with ' + recipient);
            }
        });
        return;
    }

    if (body.type !== 'message.received') return;
    if (alreadySeen(obj.id)) return;

    var from = obj.from;
    var text = obj.body || obj.text || obj.content;
    if (!from || !text) return;
    if (!isForPrimary(obj)) { console.log('Ignored: not the Primary line'); return; }

    // Pete's cell: admin commands; anything else from his cell is treated as a TEST applicant (he tests from his phone)
    if (normalizePhone(from) === normalizePhone(ALERT_NUMBER) && isAdminCommand(text)) {
        withLock('admin', function() { return handleAdmin(text); });
        return;
    }
    // Our own lines never get screened (except the test line)
    if (inList(OWN_NUMBERS, from) && !inList(TEST_NUMBERS, from)) return;

    withLock(from, async function() {
        if (!(await isBotEnabled())) { console.log('Bot disabled, ignoring ' + from); return; }
        if (await isBlocked(from)) { console.log('Blocked number ignored: ' + from); return; }
        await handleIncoming(from, text, obj.id);
    });
});

function isForPrimaryOutgoing(obj) {
    if (obj.direction && obj.direction !== 'outgoing') return false;
    if (obj.phoneNumberId) return obj.phoneNumberId === PRIMARY_PHONE_ID;
    return normalizePhone(obj.from) === normalizePhone(PRIMARY_NUMBER);
}

// ───────────────────────── DAY-BEFORE CHECK ─────────────────────────
// Sunday 6 PM (Denver): text Pete who is ready for Monday and who has not sent CONFIRMO yet.
async function dayBeforeCheck() {
    try {
        var p = denverParts(new Date());
        if (p.date !== JOB.dayBeforeDate || p.hour < 18) return;
        if (await kvGet('sent:daybefore:' + JOB.dayBeforeDate)) return;
        await kvSet('sent:daybefore:' + JOB.dayBeforeDate, true);
        var keys = await kvKeys('conv:');
        var lines = [];
        for (var i = 0; i < keys.length; i++) {
            var st = await kvGet(keys[i]);
            if (!st || st.test || st.stage !== 'call_pending') continue;
            lines.push((st.confirmed ? '✅ ' : '❌ NO confirmó: ') + (st.profile.name || '?') + ' ' + st.phone);
        }
        await sendSms(ALERT_NUMBER, 'Resumen para el lunes (CONFIRMO):\n' + (lines.length ? lines.join('\n') : 'Nadie en lista de llamada.'), { alert: true });
    } catch (e) { console.error('dayBeforeCheck error', e.message); }
}
setInterval(dayBeforeCheck, 10 * 60 * 1000);

// ───────────────────────── OTHER ENDPOINTS ─────────────────────────
// Plain text Claude endpoint used by the Tasker voice assistant: GET /ask?q=...
app.get('/ask', function(req, res) {
    var question = req.query.q;
    res.set('Content-Type', 'text/plain');
    if (!question) { res.send('No question provided.'); return; }
    callClaude('You are a helpful business assistant for Pete, owner of Shynex House Cleaning in Northern Colorado. Keep responses concise and spoken-word friendly - no bullet points, no markdown, just natural conversational sentences. Max 3-4 sentences unless asked for more.',
        [{ role: 'user', content: String(question) }], 500)
        .then(function(t) { res.send(t); })
        .catch(function(e) { console.error('Claude ask error:', e.message); res.send('Sorry I could not get a response right now.'); });
});

app.get('/', function(req, res) {
    res.send('Shynex Recruiting Agent v2 is running.');
});

// Exported for local tests
module.exports = { app: app, callWindow: callWindow, denverParts: denverParts, handleIncoming: handleIncoming, _set: function(o) {
    if (o.callClaude) callClaude = o.callClaude;
    if (o.sendSms) sendSms = o.sendSms;
}, kvGet: kvGet, loadState: loadState };

if (require.main === module) {
    var PORT = process.env.PORT || 3000;
    app.listen(PORT, function() { console.log('Shynex Recruiting Agent v2 running on port ' + PORT); });
}
var express = require('express');
var axios = require('axios');
var app = express();

app.use(express.json());

var CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
var OPENPHONE_API_KEY = process.env.OPENPHONE_API_KEY;
var OPENPHONE_FROM_NUMBER = process.env.OPENPHONE_FROM_NUMBER;

var RESET_KEYWORD = 'SHYNEXRESET';
var ALERT_NUMBER = '+19706463345';

// Numbers to completely ignore - no reply, no screening, no state changes
var BLOCKED_NUMBERS = ['9708619331', '9708045674', '9704051134'];

function normalizePhone(raw) {
    var digits = String(raw).replace(/[^0-9]/g, '');
    if (digits.length > 10) {
        digits = digits.slice(digits.length - 10);
    }
    return digits;
}

var slots = [
    { day: 'Tuesday June 30th', time: '10:00 AM', booked: false, bookedBy: null },
    { day: 'Tuesday June 30th', time: '10:30 AM', booked: false, bookedBy: null },
    { day: 'Tuesday June 30th', time: '11:00 AM', booked: false, bookedBy: null },
    { day: 'Tuesday June 30th', time: '11:30 AM', booked: false, bookedBy: null },
    { day: 'Tuesday June 30th', time: '12:00 PM', booked: false, bookedBy: null },
    { day: 'Tuesday June 30th', time: '12:30 PM', booked: false, bookedBy: null },
    { day: 'Tuesday June 30th', time: '1:00 PM', booked: false, bookedBy: null },
    { day: 'Tuesday June 30th', time: '1:30 PM', booked: false, bookedBy: null },
    { day: 'Tuesday June 30th', time: '2:00 PM', booked: false, bookedBy: null },
    { day: 'Tuesday June 30th', time: '2:30 PM', booked: false, bookedBy: null },
    { day: 'Tuesday June 30th', time: '3:00 PM', booked: false, bookedBy: null },
    { day: 'Wednesday July 1st', time: '10:00 AM', booked: false, bookedBy: null },
    { day: 'Wednesday July 1st', time: '10:30 AM', booked: false, bookedBy: null },
    { day: 'Wednesday July 1st', time: '11:00 AM', booked: false, bookedBy: null },
    { day: 'Wednesday July 1st', time: '11:30 AM', booked: false, bookedBy: null },
    { day: 'Wednesday July 1st', time: '12:00 PM', booked: false, bookedBy: null },
    { day: 'Wednesday July 1st', time: '12:30 PM', booked: false, bookedBy: null },
    { day: 'Wednesday July 1st', time: '1:00 PM', booked: false, bookedBy: null },
    { day: 'Wednesday July 1st', time: '1:30 PM', booked: false, bookedBy: null },
    { day: 'Wednesday July 1st', time: '2:00 PM', booked: false, bookedBy: null },
    { day: 'Wednesday July 1st', time: '2:30 PM', booked: false, bookedBy: null },
    { day: 'Wednesday July 1st', time: '3:00 PM', booked: false, bookedBy: null }
];

function slotLabel(slot) {
    return slot.day + ' at ' + slot.time;
}

function getAvailableSlots() {
    // Offer both interview days; the applicant may pick either day
    var available = [];
    for (var i = 0; i < slots.length; i++) {
        if (!slots[i].booked) available.push(slots[i]);
    }
    return available;
}

function bookSlot(label, phone) {
    for (var i = 0; i < slots.length; i++) {
        if (slotLabel(slots[i]) === label && !slots[i].booked) {
            slots[i].booked = true;
            slots[i].bookedBy = phone;
            return true;
        }
    }
    return false;
}

function formatAvailableSlots() {
    var available = getAvailableSlots();
    if (available.length === 0) return null;
    var list = '';
    for (var i = 0; i < available.length; i++) {
        list += '- ' + slotLabel(available[i]) + '\n';
    }
    return list.trim();
}

// Mode tracking per phone number
// modes: 'new' | 'returning_check' | 'city_check' | 'screening' | 'scheduling' | 'done'
var userMode = {};
var userCity = {};
var userPhone = {};
var conversations = {};
var completed = {};
var calledAlready = {};

var GREETING_PROMPT =
"You are a bilingual (English/Spanish) assistant for Shynex House Cleaning. " +
"Your first message to anyone who texts in is ALWAYS this — match their language:\n\n" +
"Spanish: 'Hola! Gracias por tu interes en Shynex House Cleaning. Ya habiamos hablado antes o eres nuevo/a?'\n\n" +
"English: 'Hi! Thanks for your interest in Shynex House Cleaning. Have we spoken before or are you new?'\n\n" +
"Send this and nothing else. Wait for their response.";

var CITY_CHECK_PROMPT =
"You are a bilingual (English/Spanish) assistant for Shynex House Cleaning. " +
"The person has indicated they have spoken with us before. " +
"Ask them what city they live in to determine next steps. Match their language.\n\n" +
"Spanish: 'Perfecto! En que ciudad vives?'\n" +
"English: 'Perfect! What city do you live in?'\n\n" +
"Send this and nothing else.";

var SCREENING_PROMPT =
"You are a bilingual (English/Spanish) AI recruiting assistant for Shynex House Cleaning, " +
"a residential cleaning company in Northern Colorado. " +
"Your job is to screen new applicants who text in after seeing a job posting.\n\n" +

"LANGUAGE RULE:\n" +
"- Match the language the applicant uses. Never mix languages.\n" +
"- Keep messages short, warm, and conversational.\n\n" +

"OPENING FOR NEW APPLICANTS:\n" +
"Spanish: 'Excelente! Antes de empezar, queremos que sepas por que nos encanta nuestro equipo:\n" +
"- Trabajo como contratista independiente - eres tu propio jefe\n" +
"- Promedio de $25-$35/hr\n" +
"- Gente amable y respetuosa\n" +
"- Horario flexible - tiempo completo y parcial disponible\n\n" +
"Me puedes decir tu nombre?'\n\n" +
"English: 'Great! Before we start, here is why people love working with us:\n" +
"- Independent contractor work - you are your own boss\n" +
"- Average $25-$35/hr\n" +
"- Friendly, respectful people to work with\n" +
"- Flexible schedule - full and part time available\n\n" +
"What is your name?'\n\n" +

"SCREENING QUESTIONS - ONE AT A TIME IN ORDER:\n" +
"1. Name\n" +
"2. SPANISH ONLY: Hablas algo de ingles?\n" +
"3. What city do you live in?\n" +
"4. Are you available and ready to start if you qualify?\n" +
"5. Do you have your own reliable transportation to get to the job sites?\n" +
"6. Do you have a helper who could work alongside you? (It is okay if not.)\n" +
"7. Do you have your own cleaning supplies?\n" +
"8. Do you have any cleaning experience?\n" +
"9. Is there anything that might get in the way of you starting?\n" +
"10. Best way to reach you - phone or WhatsApp?\n\n" +

"DISQUALIFY ONLY IF:\n" +
"- Not available or not ready to start\n" +
"- Does not have their own transportation\n" +
"- Does not have their own cleaning supplies\n" +
"- Rude or hostile\n\n" +
"BEFORE DISQUALIFYING for transportation or supplies, ask once to confirm in case they answered by mistake - only disqualify if they confirm. If they correct an earlier answer or say they made a mistake, accept it and keep screening normally.\n\n" +

"DISQUALIFICATION - English: 'Thank you for your interest. Unfortunately this position is not the right fit at this time, but if anything changes we will reach out. We appreciate your time.'\n" +
"DISQUALIFICATION - Spanish: 'Gracias por tu interes. Desafortunadamente esta posicion no es la indicada en este momento, pero si algo cambia nos comunicaremos. Apreciamos tu tiempo.'\n\n" +

"AFTER ALL QUESTIONS ANSWERED - send this closing to move them to scheduling a phone interview:\n" +
"English: 'You are a great fit! The next step is a quick phone interview this Tuesday or Wednesday between 10am and 3pm. Reply READY and I will share the available phone interview times.'\n" +
"Spanish: 'Eres ideal para el puesto! El siguiente paso es una entrevista telefonica rapida este martes o miercoles entre las 10am y las 3pm. Responde LISTO y te comparto los horarios disponibles para la entrevista telefonica.'\n\n" +

"COMMON QUESTIONS:\n" +
"- Pay: independent contractor, average $25-35/hr\n" +
"- Supplies: you must bring your own cleaning supplies\n" +
"- Transportation: you must have your own reliable transportation\n" +
"- Experience: not required\n" +
"- Hours / schedule / part or full time: this is flexible independent contractor work, jobs as we go that can build into a fuller schedule, details on the call. Answer generally and do NOT bring up the specific upcoming job.\n" +
"- Start date, the first job, and any locations: all confirmed on the call. Never name a start day or promise a specific job over text.\n\n" +

"RULES:\n" +
"- One question at a time\n" +
"- Never mention owner name\n" +
"- Never give exact street addresses; job locations and start details are discussed on the call\n" +
"- For questions about hours, schedule, start date, or the job, say it is flexible contractor work (jobs as we go, details on the call); never name a start day over text\n" +
"- 2-4 sentences max per message";

var SCHEDULING_PROMPT =
"You are a bilingual (English/Spanish) scheduling assistant for Shynex House Cleaning. " +
"Your only job is to book a phone interview for Tuesday June 30th or Wednesday July 1st.\n\n" +

"LANGUAGE RULE: Match the candidate's language.\n\n" +

"YOUR FLOW:\n" +
"1. Briefly confirm: if you qualify, are you available and ready to start? (Skip if they already confirmed.)\n" +
"   - YES: move on to booking the phone interview.\n" +
"   - NO: 'No problem at all. Someone will reach out about future opportunities. Thank you!' - end conversation\n\n" +
"2. Book the phone interview. Offer both days: Tuesday June 30th or Wednesday July 1st, anytime between 10:00 AM and 3:00 PM. " +
"Ask which day and time works best for them. " +
"Only offer the exact times listed under AVAILABLE PHONE INTERVIEW TIMES below - never offer a time that is not listed.\n\n" +
"3. When they pick a time, write SLOT_BOOKED:[exact time label from the list] on its own line then send confirmation:\n" +
"   English: 'Perfect! Your phone interview is booked for [time]. Someone from our team will call you then. If it goes well, we will set up a quick in-person meet in Greeley and go over the next steps on the call. We look forward to speaking with you!'\n" +
"   Spanish: 'Perfecto! Tu entrevista telefonica queda agendada para [time]. Alguien de nuestro equipo te llamara a esa hora. Si todo sale bien, coordinaremos una reunion rapida en persona en Greeley y veremos los siguientes pasos en la llamada. Esperamos hablar contigo!'\n\n" +
"4. If a time is taken, apologize and offer the remaining listed times.\n" +
"5. If no times are left: 'All interview times are taken but someone will reach out to you soon.'\n\n" +
"AVAILABLE SLOTS PLACEHOLDER\n\n" +
"IMPORTANT: Always confirm they are available to start first. Only offer the exact times listed above.";

function sendMessage(to, content, callback) {
    axios.post('https://api.openphone.com/v1/messages', {
        content: content,
        from: OPENPHONE_FROM_NUMBER,
        to: [to]
    }, {
        headers: {
            'Authorization': OPENPHONE_API_KEY,
            'Content-Type': 'application/json'
        }
    }).then(function(response) {
        console.log('Message sent to ' + to);
        if (callback) callback(null, response.data);
    }).catch(function(error) {
        var msg = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error('OpenPhone send error:', msg);
        if (callback) callback(error, null);
    });
}

function sendAlert(from, name, city, bookedTime) {
    var isGreeley = city && city.toLowerCase().indexOf('greeley') !== -1;
    var tag = isGreeley ? 'GREELEY - URGENT' : 'NON-GREELEY - FUTURE';
    var callInfo = bookedTime ? 'Phone interview booked: ' + bookedTime : 'No phone interview booked';
    var msg = 'SHYNEX CANDIDATE [' + tag + ']\n' +
              'Name: ' + (name || 'Unknown') + '\n' +
              'City: ' + (city || 'Unknown') + '\n' +
              'Phone: ' + from + '\n' +
              callInfo + '\n' +
              'Check OpenPhone for full conversation.';
    sendMessage(ALERT_NUMBER, msg, null);
}

function callClaude(systemPrompt, messages, callback) {
    axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system: systemPrompt,
        messages: messages
    }, {
        headers: {
            'x-api-key': CLAUDE_API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
        }
    }).then(function(response) {
        var text = response.data.content[0].text;
        callback(null, text);
    }).catch(function(error) {
        var msg = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error('Claude API error:', msg);
        callback(error, null);
    });
}

function handleScheduling(from, messageText) {
    if (!conversations[from + '_sched']) {
        conversations[from + '_sched'] = [];
    }

    conversations[from + '_sched'].push({ role: 'user', content: messageText });

    var availableSlots = formatAvailableSlots();
    var schedPrompt = SCHEDULING_PROMPT;
    if (availableSlots) {
        schedPrompt = schedPrompt.replace(
            'AVAILABLE SLOTS PLACEHOLDER',
            'AVAILABLE PHONE INTERVIEW TIMES (offer only these):\n' + availableSlots
        );
        // inject city context
        var cityInfo = userCity[from] ? 'The candidate lives in ' + userCity[from] + '.' : '';
        schedPrompt = schedPrompt + '\n\n' + cityInfo;
    } else {
        schedPrompt = schedPrompt.replace(
            'AVAILABLE SLOTS PLACEHOLDER',
            'ALL PHONE INTERVIEW TIMES ARE FULLY BOOKED. Tell them warmly all times are taken but someone will reach out soon.'
        );
    }

    callClaude(schedPrompt, conversations[from + '_sched'], function(err, reply) {
        if (err) return;

        var slotMatch = reply.match(/SLOT_BOOKED:([^\n]+)/);
        var cleanReply = reply.replace(/SLOT_BOOKED:[^\n]+\n?/, '').trim();

        if (slotMatch) {
            var bookedTime = slotMatch[1].trim();
            var success = bookSlot(bookedTime, from);
            if (success) {
                console.log('Slot booked:', bookedTime, 'for', from);
                completed[from] = true;
                userMode[from] = 'done';
                sendMessage(from, cleanReply, null);
                sendAlert(from, userPhone[from], userCity[from], bookedTime);
            } else {
                var newAvailable = formatAvailableSlots();
                var sorryMsg = 'Lo siento, ese horario acaba de ser tomado. Horarios disponibles:\n' +
                    (newAvailable || 'No hay mas horarios disponibles hoy.');
                sendMessage(from, sorryMsg, null);
                conversations[from + '_sched'].push({ role: 'assistant', content: sorryMsg });
            }
        } else {
            sendMessage(from, cleanReply, null);
            conversations[from + '_sched'].push({ role: 'assistant', content: cleanReply });

            var lowerReply = cleanReply.toLowerCase();
            var isDone = (
                lowerReply.indexOf('reach out') !== -1 ||
                lowerReply.indexOf('future opportunities') !== -1 ||
                lowerReply.indexOf('en contacto') !== -1 ||
                lowerReply.indexOf('oportunidades futuras') !== -1 ||
                lowerReply.indexOf('slots are taken') !== -1 ||
                lowerReply.indexOf('no hay mas') !== -1
            );
            if (isDone) {
                completed[from] = true;
                userMode[from] = 'done';
            }
        }
    });
}

app.post('/webhook', function(req, res) {
    res.status(200).json({ received: true });

    var body = req.body;
    if (!body) return;

    // ----- Unanswered incoming call: send a one-time Spanish text -----
    if (body.type === 'call.completed') {
        var callObj = body.data && body.data.object;
        if (!callObj) return;
        if (callObj.direction !== 'incoming') return;
        if (callObj.answeredAt) return;
        var caller = callObj.from;
        if (!caller) return;
        if (caller === OPENPHONE_FROM_NUMBER) return;
        if (BLOCKED_NUMBERS.indexOf(normalizePhone(caller)) !== -1) {
            console.log('Blocked number called, ignored: ' + caller);
            return;
        }
        if (userMode[caller] || completed[caller] || calledAlready[caller]) return;
        calledAlready[caller] = true;
        sendMessage(caller, 'Hola! Gracias por llamar a Shynex House Cleaning. Por ahora atendemos por mensaje de texto para ver si calificas antes de agendar una llamada. Responde aqui y con gusto te ayudo a empezar!', null);
        console.log('Missed call auto-reply sent to ' + caller);
        return;
    }

    if (body.type !== 'message.received') return;

    var obj = body.data && body.data.object;
    if (!obj) return;

    var from = obj.from;

    // Ignore texts from blocked numbers - no reply, no screening, no state changes
    if (BLOCKED_NUMBERS.indexOf(normalizePhone(from)) !== -1) {
        console.log('Blocked number ignored: ' + from);
        return;
    }
    var messageText = obj.body || obj.content || obj.text;

    if (!from || !messageText) return;
    if (from === OPENPHONE_FROM_NUMBER) return;

    if (messageText.trim().toUpperCase() === RESET_KEYWORD) {
        conversations[from] = [];
        completed[from] = false;
        userMode[from] = null;
        userCity[from] = null;
        userPhone[from] = null;
        sendMessage(from, 'Conversation reset. Send any message to start over.', null);
        console.log('Conversation reset for', from);
        return;
    }

    if (completed[from]) {
        console.log('Conversation already completed for', from);
        return;
    }

    console.log('Incoming from ' + from + ': ' + messageText);
    var lowerText = messageText.toLowerCase();

    // ─────────────────────────────────────────────
    // STEP 1 - BRAND NEW - ask returning or new
    // ─────────────────────────────────────────────
    if (!userMode[from]) {
        userMode[from] = 'greeting';
        var greetingMsg = lowerText.indexOf('hola') !== -1 ||
            lowerText.indexOf('buenos') !== -1 ||
            lowerText.indexOf('buenas') !== -1 ||
            lowerText.indexOf('trabajo') !== -1 ?
            'Hola! Gracias por tu interes en Shynex House Cleaning. Disculpa si ya habiamos hablado antes — soy un asistente de IA y nuestro sistema se reinicio ayer. Solo quiero asegurarme de darte el mejor servicio. Ya habiamos hablado antes o eres nuevo/a?' :
            'Hi! Thanks for your interest in Shynex House Cleaning. Apologies if we have spoken before — I am an AI assistant and our system reset yesterday. I just want to make sure I take care of you properly. Have we spoken before or are you new?';
        sendMessage(from, greetingMsg, null);
        return;
    }

    // ─────────────────────────────────────────────
    // STEP 2 - GREETING SENT - check returning or new
    // ─────────────────────────────────────────────
    if (userMode[from] === 'greeting') {
        var isReturning = (
            lowerText.indexOf('si') !== -1 ||
            lowerText.indexOf('yes') !== -1 ||
            lowerText.indexOf('ya') !== -1 ||
            lowerText.indexOf('hablamos') !== -1 ||
            lowerText.indexOf('spoke') !== -1 ||
            lowerText.indexOf('before') !== -1 ||
            lowerText.indexOf('hable') !== -1
        );
        if (isReturning) {
            userMode[from] = 'city_check';
            var cityMsg = lowerText.indexOf('si') !== -1 || lowerText.indexOf('ya') !== -1 || lowerText.indexOf('hablamos') !== -1 ?
                'Perfecto! En que ciudad vives?' :
                'Perfect! What city do you live in?';
            sendMessage(from, cityMsg, null);
        } else {
            userMode[from] = 'screening';
            conversations[from] = [{ role: 'user', content: messageText }];
            callClaude(SCREENING_PROMPT, conversations[from], function(err, reply) {
                if (err) return;
                conversations[from].push({ role: 'assistant', content: reply });
                sendMessage(from, reply, null);
            });
        }
        return;
    }

    // ─────────────────────────────────────────────
    // STEP 3 - CITY CHECK for returning candidates
    // ─────────────────────────────────────────────
    if (userMode[from] === 'city_check') {
        userCity[from] = messageText.trim();
        userMode[from] = 'scheduling';
        handleScheduling(from, messageText);
        return;
    }

    // ─────────────────────────────────────────────
    // STEP 4 - SCHEDULING MODE
    // ─────────────────────────────────────────────
    if (userMode[from] === 'scheduling') {
        handleScheduling(from, messageText);
        return;
    }

    // ─────────────────────────────────────────────
    // STEP 5 - SCREENING MODE for new applicants
    // ─────────────────────────────────────────────
    if (userMode[from] === 'screening') {
        if (!conversations[from]) conversations[from] = [];
        conversations[from].push({ role: 'user', content: messageText });

        callClaude(SCREENING_PROMPT, conversations[from], function(err, reply) {
            if (err) return;

            conversations[from].push({ role: 'assistant', content: reply });
            sendMessage(from, reply, null);

            var lowerReply = reply.toLowerCase();

            // Capture the candidate's name from the answer to the name question
            if (!userPhone[from] && messageText.length < 40) {
                var prevNameMsg = conversations[from].length >= 3 ? conversations[from][conversations[from].length - 3] : null;
                if (prevNameMsg && prevNameMsg.role === 'assistant') {
                    var prevNameLower = prevNameMsg.content.toLowerCase();
                    if (prevNameLower.indexOf('your name') !== -1 || prevNameLower.indexOf('tu nombre') !== -1) {
                        userPhone[from] = messageText.trim();
                    }
                }
            }

            // Extract city when Claude asks about it
            var asksCity = lowerReply.indexOf('city') !== -1 || lowerReply.indexOf('ciudad') !== -1 || lowerReply.indexOf('vives') !== -1;
            if (!asksCity && !userCity[from] && messageText.length < 40) {
                var prevMsg = conversations[from].length >= 3 ? conversations[from][conversations[from].length - 3] : null;
                if (prevMsg && prevMsg.role === 'assistant') {
                    var prevLower = prevMsg.content.toLowerCase();
                    if (prevLower.indexOf('city') !== -1 || prevLower.indexOf('ciudad') !== -1 || prevLower.indexOf('vives') !== -1) {
                        userCity[from] = messageText.trim();
                    }
                }
            }

            var isDisqualified = (
                lowerReply.indexOf('not the right fit') !== -1 ||
                lowerReply.indexOf('no es la indicada') !== -1
            );
            var screeningComplete = (
                lowerReply.indexOf('share the available phone interview times') !== -1 ||
                lowerReply.indexOf('horarios disponibles para la entrevista') !== -1
            );

            if (isDisqualified) {
                // Keep them in screening so they can correct a mistaken answer
                console.log('Soft disqualification (left open for correction):', from);
            }

            if (screeningComplete) {
                console.log('Screening complete, moving to scheduling:', from);
                userMode[from] = 'scheduling';
                sendAlert(from, userPhone[from], userCity[from], null);
            }
        });
        return;
    }
});

app.get('/slots', function(req, res) {
    var result = [];
    for (var i = 0; i < slots.length; i++) {
        result.push({
            day: slots[i].day,
            time: slots[i].time,
            booked: slots[i].booked,
            bookedBy: slots[i].bookedBy || 'available'
        });
    }
    res.json(result);
});

// ─────────────────────────────────────────────
// PLAIN TEXT CLAUDE ENDPOINT FOR TASKER
// GET /ask?q=your+question+here
// Returns plain text response only - no JSON
// ─────────────────────────────────────────────
app.get('/ask', function(req, res) {
    var question = req.query.q;
    if (!question) {
        res.set('Content-Type', 'text/plain');
        res.send('No question provided.');
        return;
    }

    axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system: 'You are a helpful business assistant for Pete, owner of Shynex House Cleaning in Northern Colorado. Keep responses concise and spoken-word friendly - no bullet points, no markdown, just natural conversational sentences. Max 3-4 sentences unless asked for more.',
        messages: [{ role: 'user', content: question }]
    }, {
        headers: {
            'x-api-key': CLAUDE_API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
        }
    }).then(function(response) {
        var text = response.data.content[0].text;
        res.set('Content-Type', 'text/plain');
        res.send(text);
    }).catch(function(error) {
        var msg = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error('Claude ask error:', msg);
        res.set('Content-Type', 'text/plain');
        res.send('Sorry I could not get a response right now.');
    });
});

app.get('/', function(req, res) {
    res.send('Shynex Recruiting Agent is running.');
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
    console.log('Shynex Recruiting Agent running on port ' + PORT);
});
