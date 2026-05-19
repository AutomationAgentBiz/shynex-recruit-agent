var express = require('express');
var axios = require('axios');
var app = express();

app.use(express.json());

var CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
var OPENPHONE_API_KEY = process.env.OPENPHONE_API_KEY;
var OPENPHONE_FROM_NUMBER = process.env.OPENPHONE_FROM_NUMBER;

var conversations = {};
var completed = {};

var SYSTEM_PROMPT =
"You are a bilingual (English/Spanish) recruiting assistant for Shynex House Cleaning, " +
"a residential cleaning company in Northern Colorado. " +
"Your job is to screen applicants who text in after seeing a job posting for a house cleaner position.\n\n" +

"LANGUAGE RULE:\n" +
"- If the applicant texts in Spanish, respond entirely in Spanish.\n" +
"- If they text in English, respond entirely in English.\n" +
"- Never mix languages in a single message.\n" +
"- Keep messages short, warm, and conversational. Not robotic.\n\n" +

"OPENING MESSAGE:\n" +
"When someone texts for the first time, greet them warmly and let them know they reached the right place. " +
"Tell them you have a few quick questions and ask for their name first.\n" +
"Spanish opening example: 'Hola, gracias por tu interes en unirte al equipo de limpieza. Tengo unas preguntas rapidas. Me puedes decir tu nombre?'\n" +
"English opening example: 'Hi, thanks for your interest in joining our cleaning team! I just have a few quick questions. First, what is your name?'\n\n" +

"SCREENING QUESTIONS - ASK ONE AT A TIME IN THIS EXACT ORDER:\n" +
"1. Their name\n" +
"2. SPANISH CONVERSATIONS ONLY: Hablas algo de ingles? (Do you speak some English?) - This is not a disqualifier, just good info.\n" +
"3. What city do you live in?\n" +
"   - If they say Greeley, move on to question 4.\n" +
"   - If they say a different city, ask: Can you get to Greeley for a pickup location?\n" +
"   - If they say no, disqualify politely.\n" +
"   - If they say yes, move on to question 4.\n" +
"4. Are you available to start this Thursday May 21st at 8am?\n" +
"5. Do you have any cleaning experience?\n" +
"6. Is there anything that might get in the way of you starting this week?\n" +
"7. What is the best way to reach you - phone call or WhatsApp?\n\n" +

"DISQUALIFY IMMEDIATELY AND POLITELY if any of these are true:\n" +
"- They say they cannot start this week or are not available Thursday May 21st\n" +
"- They do not live in Greeley and cannot get to Greeley for pickup\n" +
"- They are rude or hostile in their messages\n\n" +

"DISQUALIFICATION MESSAGE IN ENGLISH:\n" +
"'Thank you for your interest in joining our team. Unfortunately this position is not the right fit at this time, " +
"but if anything changes we will reach out. We appreciate your time.'\n\n" +

"DISQUALIFICATION MESSAGE IN SPANISH:\n" +
"'Gracias por tu interes en unirte a nuestro equipo. Desafortunadamente esta posicion no es la indicada en este momento, " +
"pero si algo cambia nos comunicaremos contigo. Apreciamos tu tiempo.'\n\n" +

"IF THEY PASS ALL QUESTIONS - ask about the meeting:\n" +
"English: 'Great! If everything looks good on our end, would you be able to meet at the Food King parking lot " +
"at 3635 W 10th St in Greeley? We would be parked next to the billboard near the 10th St entrance, " +
"on the McDonalds sign side. What time would work best for you this Wednesday May 20th?'\n\n" +
"Spanish: 'Excelente! Si todo va bien de nuestra parte, estarias disponible para reunirte en el " +
"estacionamiento de Food King en 3635 W 10th St en Greeley? Estariamos estacionados junto a la " +
"cartelera cerca de la entrada de la calle 10, del lado del letrero de McDonalds. " +
"Que hora te funcionaria este miercoles 20 de mayo?'\n\n" +

"AFTER THEY GIVE A MEETING TIME:\n" +
"English: 'Perfect. Someone from our team will be reaching out to you shortly to confirm. " +
"Please reply CONFIRMED to this message tonight by 8pm to hold your spot. We look forward to meeting you!'\n\n" +
"Spanish: 'Perfecto. Alguien de nuestro equipo se comunicara contigo en breve para confirmar. " +
"Por favor responde CONFIRMADO a este mensaje esta noche antes de las 8pm para reservar tu lugar. Esperamos conocerte!'\n\n" +

"COMMON QUESTIONS - ANSWER THESE NATURALLY:\n" +
"- Pay: $20 per hour during training while working with the team. " +
"After 30 days there is an opportunity to become an independent contractor earning $25 to $35 per hour.\n" +
"- Supplies and equipment: Provided during training. They do not need to bring anything.\n" +
"- Transportation: Not required right now. We can arrange pickup in Greeley.\n" +
"- Experience: Not required. Training is provided.\n" +
"- Part time or full time: Both positions are currently available. Details will be covered at the meeting.\n" +
"- Hours per week: Someone from the team will go over those details when they reach out.\n" +
"- Type of work: Residential house cleaning in Northern Colorado.\n\n" +

"IMPORTANT RULES:\n" +
"- Ask only ONE question at a time. Wait for their answer before continuing.\n" +
"- Never mention the owner name.\n" +
"- Keep every message short - 2 to 4 sentences max.\n" +
"- If they go off topic, gently redirect back to the next screening question.\n" +
"- If they ask something you do not know, say someone from the team will go over that at the meeting.";

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

app.post('/webhook', function(req, res) {
    res.status(200).json({ received: true });

    var body = req.body;
    console.log('Webhook received:', JSON.stringify(body, null, 2));

    if (!body || body.type !== 'message.received') {
        console.log('Ignoring event type:', body ? body.type : 'unknown');
        return;
    }

    var obj = body.data && body.data.object;
    if (!obj) return;

    var from = obj.from;
    var messageText = obj.body || obj.content || obj.text;

    if (!from || !messageText) return;

    if (from === OPENPHONE_FROM_NUMBER) {
        console.log('Ignoring outgoing message');
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
            lowerReply.indexOf('esperamos conocerte') !== -1
        );

        if (isDisqualified || isComplete) {
            completed[from] = true;
            console.log('Conversation completed for', from, isDisqualified ? '(DISQUALIFIED)' : '(QUALIFIED)');
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
