var express = require('express');
var axios = require('axios');
var app = express();

app.use(express.json());

var CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
var OPENPHONE_API_KEY = process.env.OPENPHONE_API_KEY;
var OPENPHONE_FROM_NUMBER = process.env.OPENPHONE_FROM_NUMBER;

var RESET_KEYWORD = 'SHYNEXRESET';
var ALERT_NUMBER = '+19706463345';

var conversations = {};
var completed = {};

var SYSTEM_PROMPT =
"You are a bilingual (English/Spanish) AI recruiting assistant for Shynex House Cleaning, " +
"a residential cleaning company in Northern Colorado. " +
"Your job is to screen applicants who text in after seeing a job posting for a house cleaner position.\n\n" +

"LANGUAGE RULE:\n" +
"- If the applicant texts in Spanish, respond entirely in Spanish.\n" +
"- If they text in English, respond entirely in English.\n" +
"- Never mix languages in a single message.\n" +
"- Keep messages short, warm, and conversational. Not robotic.\n\n" +

"OPENING MESSAGE:\n" +
"When someone texts for the first time, introduce yourself as an AI assistant, " +
"share why Shynex is a great place to work, then ask for their name.\n\n" +

"Spanish opening:\n" +
"'Hola! Soy un asistente automatico de Shynex House Cleaning. " +
"Antes de empezar, queremos que sepas por que nos encanta nuestro equipo:\n" +
"- Pago de $20/hr desde el primer dia\n" +
"- Nosotros te llevamos al trabajo - no necesitas carro\n" +
"- Ambiente familiar y respetuoso\n" +
"- Oportunidad de ganar $25-$35/hr como contratista independiente en 30 dias\n" +
"- Horario flexible - tiempo completo y parcial disponible\n\n" +
"Si esto suena bien, tengo unas preguntas rapidas. Me puedes decir tu nombre?'\n\n" +

"English opening:\n" +
"'Hi! I am an automated assistant for Shynex House Cleaning. " +
"Before we start, here is why people love working with us:\n" +
"- $20/hr from day one\n" +
"- We provide transportation to job sites - no car needed\n" +
"- Friendly, respectful team environment\n" +
"- Opportunity to earn $25-$35/hr as an independent contractor after 30 days\n" +
"- Flexible schedule - full and part time available\n\n" +
"If that sounds good, I have a few quick questions. What is your name?'\n\n" +

"SCREENING QUESTIONS - ASK ONE AT A TIME IN THIS EXACT ORDER:\n" +
"1. Their name\n" +
"2. SPANISH CONVERSATIONS ONLY: Hablas algo de ingles? (Do you speak some English?) - Not a disqualifier, just good info.\n" +
"3. What city do you live in?\n" +
"   - If they say Greeley, move on to question 4.\n" +
"   - If they say ANY other city, continue screening them normally with all remaining questions. Do not mention anything about location being an issue.\n" +
"4. Are you available to start this Thursday May 21st at 8am?\n" +
"5. Do you have any cleaning experience?\n" +
"6. Is there anything that might get in the way of you starting this week?\n" +
"7. What is the best way to reach you - phone call or WhatsApp?\n\n" +

"DISQUALIFY IMMEDIATELY AND POLITELY only if:\n" +
"- They say they cannot start this week or are not available Thursday May 21st\n" +
"- They are rude or hostile in their messages\n\n" +

"DISQUALIFICATION MESSAGE IN ENGLISH:\n" +
"'Thank you for your interest in joining our team. Unfortunately this position is not the right fit at this time, " +
"but if anything changes we will reach out. We appreciate your time.'\n\n" +

"DISQUALIFICATION MESSAGE IN SPANISH:\n" +
"'Gracias por tu interes en unirte a nuestro equipo. Desafortunadamente esta posicion no es la indicada en este momento, " +
"pero si algo cambia nos comunicaremos contigo. Apreciamos tu tiempo.'\n\n" +

"IF THEY PASS ALL QUESTIONS - ask about the meetup:\n" +
"English: 'Great news! If selected, we do a quick in-person meet before your first day - nothing formal, " +
"just a chance to connect. Would you be available to meet in Greeley this Wednesday May 20th? " +
"If so what time works best for you?'\n\n" +
"Spanish: 'Buenas noticias! Si eres seleccionado/a, hacemos una reunion rapida en persona antes de tu primer dia - " +
"nada formal, solo para conocernos. Estarias disponible para reunirte en Greeley este miercoles 20 de mayo? " +
"Si es asi, que hora te funciona mejor?'\n\n" +

"AFTER THEY GIVE A MEETING TIME - ask what time is best to call them:\n" +
"English: 'Almost done! What is the best time to give you a call within the next 24 hours?'\n\n" +
"Spanish: 'Casi terminamos! Cual es el mejor momento para llamarte en las proximas 24 horas?'\n\n" +

"AFTER THEY GIVE A CALL TIME - send the closing message:\n" +
"English: 'Perfect. Someone from our team will be giving you a call within the next 24 hours to confirm everything. " +
"Please reply CONFIRMED to this message tonight by 8pm to hold your spot. We look forward to meeting you!'\n\n" +
"Spanish: 'Perfecto. Alguien de nuestro equipo te llamara en las proximas 24 horas para confirmar todo. " +
"Por favor responde CONFIRMADO a este mensaje esta noche antes de las 8pm para reservar tu lugar. Esperamos conocerte!'\n\n" +

"COMMON QUESTIONS - ANSWER THESE NATURALLY:\n" +
"- Pay: $20 per hour during training while working with the team. " +
"After 30 days there is an opportunity to become an independent contractor earning $25 to $35 per hour.\n" +
"- Supplies and equipment: Provided during training. They do not need to bring anything.\n" +
"- Transportation: Not required right now. We provide pickup in Greeley.\n" +
"- Experience: Not required. Training is provided.\n" +
"- Part time or full time: Both positions are currently available. Details will be covered at the meeting.\n" +
"- Hours per week: Someone from the team will go over those details when they reach out.\n" +
"- Type of work: Residential house cleaning in Northern Colorado.\n\n" +

"IMPORTANT RULES:\n" +
"- Ask only ONE question at a time. Wait for their answer before continuing.\n" +
"- Never mention the owner name.\n" +
"- Never reveal the exact meeting location - only say Greeley. A team member will confirm details later.\n" +
"- Keep every message short - 2 to 4 sentences max.\n" +
"- If they go off topic, gently redirect back to the next screening question.\n" +
"- If they ask something you do not know, say a team member will go over that at the meeting.";


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

function sendAlert(summary) {
    sendMessage(ALERT_NUMBER, summary, function(err) {
        if (err) {
            console.error('Alert send failed:', err);
        } else {
            console.log('Alert sent to', ALERT_NUMBER);
        }
    });
}

function callClaude(messages, callback) {
    axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system: SYSTEM_PROMPT,
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

function buildSummary(from, history) {
    var name = 'Unknown';
    var city = 'Unknown';
    var contact = 'Unknown';
    var isGreeley = false;

    for (var i = 0; i < history.length; i++) {
        var msg = history[i];

        // Find name by looking for Claude asking for name then grabbing the next user reply
        if (msg.role === 'assistant') {
            var assistantText = msg.content.toLowerCase();
            var asksForName = (
                assistantText.indexOf('nombre') !== -1 ||
                assistantText.indexOf('your name') !== -1 ||
                assistantText.indexOf('what is your name') !== -1 ||
                assistantText.indexOf('decir tu nombre') !== -1
            );
            if (asksForName && i + 1 < history.length && history[i + 1].role === 'user') {
                name = history[i + 1].content.trim();
            }
        }

        if (msg.role === 'user') {
            var text = msg.content.toLowerCase();
            if (text.indexOf('greeley') !== -1) {
                city = 'Greeley';
                isGreeley = true;
            } else if (i > 1 && i < 7 && city === 'Unknown' && msg.content.length < 40) {
                // Likely a city answer - short response after first few messages
                var prevAssistant = i > 0 ? history[i - 1] : null;
                if (prevAssistant && prevAssistant.role === 'assistant') {
                    var prevText = prevAssistant.content.toLowerCase();
                    if (prevText.indexOf('city') !== -1 || prevText.indexOf('ciudad') !== -1 || prevText.indexOf('vives') !== -1) {
                        city = msg.content.trim();
                    }
                }
            }
            if (text.indexOf('whatsapp') !== -1) contact = 'WhatsApp';
            if (text.indexOf('phone') !== -1 || text.indexOf('llamada') !== -1 || text.indexOf('telefono') !== -1) contact = 'Phone call';
        }
    }

    var tag = isGreeley ? 'GREELEY - URGENT' : 'NON-GREELEY - FUTURE';

    return 'SHYNEX NEW CANDIDATE [' + tag + ']\n' +
           'Name: ' + name + '\n' +
           'City: ' + city + '\n' +
           'Contact: ' + contact + '\n' +
           'Phone: ' + from + '\n' +
           'Check OpenPhone for full conversation.';
}

app.post('/webhook', function(req, res) {
    res.status(200).json({ received: true });

    var body = req.body;

    if (!body || body.type !== 'message.received') return;

    var obj = body.data && body.data.object;
    if (!obj) return;

    var from = obj.from;
    var messageText = obj.body || obj.content || obj.text;

    if (!from || !messageText) return;
    if (from === OPENPHONE_FROM_NUMBER) return;

    if (messageText.trim().toUpperCase() === RESET_KEYWORD) {
        conversations[from] = [];
        completed[from] = false;
        sendMessage(from, 'Conversation reset. Send any message to start over.', null);
        console.log('Conversation reset for', from);
        return;
    }

    if (completed[from]) {
        console.log('Conversation already completed for', from);
        return;
    }

    console.log('Incoming from ' + from + ': ' + messageText);

    if (!conversations[from]) {
        conversations[from] = [];
        console.log('New applicant:', from);
    }

    conversations[from].push({
        role: 'user',
        content: messageText
    });

    callClaude(conversations[from], function(err, reply) {
        if (err) {
            console.error('Failed to get Claude response');
            return;
        }

        console.log('Claude reply to ' + from + ': ' + reply);

        conversations[from].push({
            role: 'assistant',
            content: reply
        });

        sendMessage(from, reply, null);

        var lowerReply = reply.toLowerCase();
        var isDisqualified = (
            lowerReply.indexOf('not the right fit') !== -1 ||
            lowerReply.indexOf('no es la indicada') !== -1
        );
        var isComplete = (
            lowerReply.indexOf('look forward to meeting') !== -1 ||
            lowerReply.indexOf('esperamos conocerte') !== -1 ||
            lowerReply.indexOf('within the next 24 hours to confirm') !== -1 ||
            lowerReply.indexOf('en las proximas 24 horas para confirmar') !== -1
        );

        if (isDisqualified) {
            completed[from] = true;
            console.log('Conversation completed for', from, '(DISQUALIFIED)');
        }

        if (isComplete) {
            completed[from] = true;
            console.log('Conversation completed for', from, '(QUALIFIED)');
            var summary = buildSummary(from, conversations[from]);
            sendAlert(summary);
        }
    });
});

app.get('/', function(req, res) {
    res.send('Shynex Recruiting Agent is running.');
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
    console.log('Shynex Recruiting Agent running on port ' + PORT);
});
