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
var BLOCKED_NUMBERS = ['9708619331', '9708045674'];

function normalizePhone(raw) {
    var digits = String(raw).replace(/[^0-9]/g, '');
    if (digits.length > 10) {
        digits = digits.slice(digits.length - 10);
    }
    return digits;
}

var slots = [
    { day: 'Sunday June 28th', time: '4:00 PM', booked: false, bookedBy: null },
    { day: 'Sunday June 28th', time: '4:30 PM', booked: false, bookedBy: null },
    { day: 'Sunday June 28th', time: '5:00 PM', booked: false, bookedBy: null },
    { day: 'Sunday June 28th', time: '5:30 PM', booked: false, bookedBy: null },
    { day: 'Sunday June 28th', time: '6:00 PM', booked: false, bookedBy: null },
    { day: 'Monday June 29th', time: '4:00 PM', booked: false, bookedBy: null },
    { day: 'Monday June 29th', time: '4:30 PM', booked: false, bookedBy: null },
    { day: 'Monday June 29th', time: '5:00 PM', booked: false, bookedBy: null },
    { day: 'Monday June 29th', time: '5:30 PM', booked: false, bookedBy: null },
    { day: 'Monday June 29th', time: '6:00 PM', booked: false, bookedBy: null }
];

function slotLabel(slot) {
    return slot.day + ' at ' + slot.time;
}

function getAvailableSlots() {
    // Fill Sunday first; only show Monday once all Sunday times are booked
    var sunday = [];
    var monday = [];
    for (var i = 0; i < slots.length; i++) {
        if (slots[i].booked) continue;
        if (slots[i].day.indexOf('Sunday') !== -1) {
            sunday.push(slots[i]);
        } else {
            monday.push(slots[i]);
        }
    }
    return sunday.length > 0 ? sunday : monday;
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
"4. Are you available to start this Tuesday June 30th at 8am if you qualify?\n" +
"5. Do you have your own reliable transportation to get to the job sites?\n" +
"6. Do you have a helper who could work alongside you? (It is okay if not.)\n" +
"7. Do you have your own cleaning supplies?\n" +
"8. Do you have any cleaning experience?\n" +
"9. Is there anything that might get in the way of starting this week?\n" +
"10. Best way to reach you - phone or WhatsApp?\n\n" +

"DISQUALIFY ONLY IF:\n" +
"- Cannot start work this Tuesday June 30th\n" +
"- Does not have their own transportation\n" +
"- Does not have their own cleaning supplies\n" +
"- Rude or hostile\n\n" +

"DISQUALIFICATION - English: 'Thank you for your interest. Unfortunately this position is not the right fit at this time, but if anything changes we will reach out. We appreciate your time.'\n" +
"DISQUALIFICATION - Spanish: 'Gracias por tu interes. Desafortunadamente esta posicion no es la indicada en este momento, pero si algo cambia nos comunicaremos. Apreciamos tu tiempo.'\n\n" +

"AFTER ALL QUESTIONS ANSWERED - send this closing to move them to scheduling a phone interview:\n" +
"English: 'You are a great fit! The next step is a quick phone interview this Sunday or Monday after 4pm. Reply READY and I will share the available phone interview times.'\n" +
"Spanish: 'Eres ideal para el puesto! El siguiente paso es una entrevista telefonica rapida este domingo o lunes despues de las 4pm. Responde LISTO y te comparto los horarios disponibles para la entrevista telefonica.'\n\n" +

"COMMON QUESTIONS:\n" +
"- Pay: independent contractor, average $25-35/hr\n" +
"- Supplies: you must bring your own cleaning supplies\n" +
"- Transportation: you must have your own reliable transportation\n" +
"- The work: two move-out house cleans on Tuesday June 30th\n" +
"- Locations (share only if asked): first move-out is in Fort Collins, second is in Greeley\n" +
"- Experience: not required\n" +
"- Full or part time: both available, details at meeting\n\n" +

"RULES:\n" +
"- One question at a time\n" +
"- Never mention owner name\n" +
"- Never give exact street addresses; only share the job cities (Fort Collins, Greeley) if asked\n" +
"- 2-4 sentences max per message";

var SCHEDULING_PROMPT =
"You are a bilingual (English/Spanish) scheduling assistant for Shynex House Cleaning. " +
"Your only job is to book a phone interview for Sunday June 28th or Monday June 29th.\n\n" +

"LANGUAGE RULE: Match the candidate's language.\n\n" +

"YOUR FLOW:\n" +
"1. Briefly confirm: if you qualify, can you start work this Tuesday June 30th at 8am? (Skip if they already confirmed.)\n" +
"   - YES: move on to booking the phone interview.\n" +
"   - NO: 'No problem at all. Someone will reach out about future opportunities. Thank you!' - end conversation\n\n" +
"2. Book the phone interview. We fill Sunday June 28th first, between 4:00 PM and 6:00 PM. " +
"Ask what time between 4:00 PM and 6:00 PM works best for them. " +
"Only offer the exact times listed under AVAILABLE PHONE INTERVIEW TIMES below - never offer a time that is not listed. " +
"When all Sunday times are taken the list will show Monday June 29th times instead.\n\n" +
"3. When they pick a time, write SLOT_BOOKED:[exact time label from the list] on its own line then send confirmation:\n" +
"   English: 'Perfect! Your phone interview is booked for [time]. Someone from our team will call you then. If it goes well, we will set up a quick in-person meet in Greeley before your first day Tuesday June 30th at 8am. We look forward to speaking with you!'\n" +
"   Spanish: 'Perfecto! Tu entrevista telefonica queda agendada para [time]. Alguien de nuestro equipo te llamara a esa hora. Si todo sale bien, coordinaremos una reunion rapida en persona en Greeley antes de tu primer dia el martes 30 de junio a las 8am. Esperamos hablar contigo!'\n\n" +
"4. If a time is taken, apologize and offer the remaining listed times.\n" +
"5. If no times are left: 'All interview times are taken but someone will reach out to you soon.'\n\n" +
"AVAILABLE SLOTS PLACEHOLDER\n\n" +
"IMPORTANT: Always confirm Tuesday June 30th 8am availability first. Only offer the exact times listed above.";

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
    if (!body || body.type !== 'message.received') return;

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

            // Extract city when Claude asks about it
            var asksCity = lowerReply.indexOf('city') !== -1 || lowerReply.indexOf('ciudad') !== -1 || lowerReply.indexOf('vives') !== -1;
            if (!asksCity && !userCity[from] && messageText.length < 40) {
                var prevMsg = conversations[from].length > 1 ? conversations[from][conversations[from].length - 2] : null;
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
                completed[from] = true;
                userMode[from] = 'done';
                console.log('Disqualified:', from);
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
