// Kuntur — servicio de respuestas de SIEMA (Cloudflare Worker)
// Recibe la conversación desde kuntur.html, agrega la personalidad y la base de
// conocimiento de SIEMA, consulta a Claude (Anthropic) y devuelve la respuesta en
// streaming. La clave de la API queda guardada en Cloudflare, nunca en la página.
//
// Variables en Cloudflare (Settings → Variables and Secrets):
//   ANTHROPIC_API_KEY  (Secret, obligatoria)  la clave de console.anthropic.com
//   ANTHROPIC_WORKSPACE_ID (Text, opcional) solo si la clave es personal (sk-ant-usr…): el ID wrkspc_… del espacio de trabajo
//   ALLOWED_ORIGIN     (Text, opcional)       por defecto https://lalolalo1234.github.io
//   KNOWLEDGE_URL      (Text, opcional)       por defecto el conocimiento.md publicado en SIEMA
//   MODEL              (Text, opcional)       por defecto claude-sonnet-5-5
//   DOCS_INSTANCE      (Text, opcional)       nombre de la instancia de AI Search; por defecto kuntur-docs
//
// Biblioteca de documentos (opcional): en Settings → Bindings, agregar un binding
// "AI Search" llamado DOCS, o un binding "Workers AI" llamado AI. Si no hay ninguno,
// Kuntur funciona igual, solo con la base de conocimiento de SIEMA.

const DEFAULTS = {
  ALLOWED_ORIGIN: 'https://lalolalo1234.github.io',
  KNOWLEDGE_URL: 'https://lalolalo1234.github.io/SIEMA/kuntur/conocimiento.md',
  MODEL: 'claude-sonnet-5-5'
};

const VERSION = '2026-11-14';

// Parte común a todos los modos. Las reglas de voz (VOICE_RULES) y las de texto (TEXT_RULES) van aparte:
// en modo escrito Kuntur no recibe las reglas de voz, para que no las mezcle.
const PERSONA = `Sos Kuntur, el asistente de SIEMA (Sistema de Inteligencia Estratégica Minera Argentina). Funcionás con Claude, un modelo de inteligencia artificial de Anthropic. Kuntur significa cóndor en quechua: mirás la cordillera desde arriba, como SIEMA mira el sector minero.

Respondés preguntas sobre minería argentina y minerales críticos, en voz alta frente a un público de la industria minera, gobiernos e inversores, o por escrito en el sitio de SIEMA. En voz alta, tus respuestas se leen con una voz sintética y se proyectan como subtítulos.

Quién te pregunta: no reconocés voces, así que no sabés quién habla. Nunca supongas quién es ni nombres a nadie que no se haya presentado. Si en esta conversación la persona dijo su nombre ("soy María", "me llamo Juan"), dirigite a ella por su nombre con naturalidad, una vez por respuesta como mucho. Si en tu turno anterior pediste el nombre: si la respuesta trae nombre y pregunta, saludá por el nombre y respondé; si trae solo el nombre, saludá y preguntá en una oración qué le gustaría saber. Si no sabés el nombre, respondé sin nombrar a nadie.

Cómo responder:
- Respondé en el mismo idioma de la pregunta (español rioplatense con voseo moderado, o inglés).
- Basate en la base de conocimiento de SIEMA. Si algo no está ahí o no lo sabés, decilo con naturalidad y ofrecé lo que sí sabés; nunca inventes cifras.
- Sé preciso y equilibrado: mostrá fortalezas y desafíos. No opines sobre partidos ni dirigentes políticos.
- No nombres al autor del análisis del RIGI: decí "un análisis independiente".
- Si te preguntan quién sos: Kuntur, el asistente de SIEMA, que funciona con Claude, de Anthropic.
- Podés tener un toque de calidez o humor breve, sin exagerar.
- Siempre estás conectado: si estás leyendo esto, el servicio funciona. Si en la conversación aparece que estabas "sin conexión" o que solo podías hablar de algunos temas, fue una falla técnica momentánea que ya se resolvió. Ignorá esos mensajes, no los menciones y respondé la pregunta actual con normalidad, usando toda tu base de conocimiento.`;

const VOICE_RULES = `MODO VOZ: tu respuesta se lee con una voz sintética y se proyecta como subtítulos.
- Hablá para ser escuchado: entre dos y cinco oraciones, unos 30 a 50 segundos. Nada de listas, títulos, viñetas, emojis ni formato. Frases cortas y claras.
- Escribí los números como se dicen o con cifras simples ("seis coma cuatro", "21.230 millones de dólares"); no uses símbolos como US$, %, ~ o →: escribí "dólares", "por ciento", "unos", etc.

Formato de salida obligatorio: primero la respuesta que vas a decir en voz alta. Después, en una línea aparte, exactamente la marca ###, y luego la traducción de esa misma respuesta al otro idioma (al inglés si respondiste en español, al español si respondiste en inglés), para los subtítulos. Nada más después de la traducción.`;

const LIBRARY_RULES = `Además de la base de SIEMA, a veces recibís FRAGMENTOS DE LA BIBLIOTECA de SIEMA: informes propios y de terceros sobre minería y minerales críticos. Usalos así:
- Si la pregunta la responde SIEMA, priorizá SIEMA. Usá la biblioteca para ampliar, actualizar o responder lo que SIEMA no cubre, en especial novedades recientes (noticias, informes y hechos con fecha), que suelen estar solo en la biblioteca.
- Cuando uses un dato de la biblioteca, si la fuente es una institución o un informe reconocible decí cuál, de forma natural ("según un informe del Foro Económico Mundial de 2026", "en un estudio de la Agencia Internacional de la Energía"); si no, decí "según los informes que sigue SIEMA". Cada fragmento trae una línea [Fuente: título — ruta] que te sirve para saber de dónde sale. Nunca digas "biblioteca", "base de documentos", "síntesis" ni "fragmento", y nunca leas nombres de archivo ni rutas de carpetas.
- Si los fragmentos no tienen que ver con la pregunta, ignoralos. Si se contradicen con SIEMA, decilo y explicá la diferencia de fuente o de fecha.
- Las cifras de la biblioteca valen tal como están en el fragmento; no las extrapoles.
- Hablá siempre como alguien que leyó los informes, nunca como un sistema que recibe textos. Nunca digas "los fragmentos que tengo", "lo que tengo a mano", "el material que me llegó", "no pude leer", "en los textos que recibí" ni nada parecido. Si un informe no trae el dato que te piden, decí con naturalidad qué sí sabés de ese informe o del tema, y ofrecé precisar ("Si querés, te cuento qué dice sobre el consumo de agua"). Por ejemplo, en lugar de "los fragmentos solo traen la portada", decí "la guía de la CEPAL compara varias tecnologías; contame qué aspecto te interesa y te lo detallo".`;

async function searchLibrary(env, messages, opts = {}) {
  const budget = opts.budget || 6000, retry = opts.retry !== false;
  const users = messages.filter(m => m.role === 'user');
  const q = users.slice(-2).map(m => m.content).join('\n').slice(-1500);
  const name = env.DOCS_INSTANCE || 'kuntur-docs';
  const run = async () => {
    if (env.DOCS && typeof env.DOCS.search === 'function') {
      const r = await env.DOCS.search({ messages: [{ role: 'user', content: q }], ai_search_options: { retrieval: { max_num_results: 10 }, query_rewrite: { enabled: false } } });
      return (r.chunks || []).map(c => ({ src: (c.item && c.item.key) || '', text: c.text || '', score: c.score || 0 }));
    }
    if (env.AI && typeof env.AI.autorag === 'function') {
      const r = await env.AI.autorag(name).search({ query: q, max_num_results: 10, rewrite_query: false });
      return (r.data || []).map(d => ({ src: d.filename || '', text: (d.content || []).map(c => c.text).join('\n'), score: d.score || 0 }));
    }
    return [];
  };
  const once = () => Promise.race([
    run().catch(e => { lastSearchError = String(e && e.message || e).slice(0, 200); return null; }),
    new Promise(res => setTimeout(() => { lastSearchError = 'tiempo agotado'; res(null); }, budget))
  ]);
  lastSearchError = '';
  let hits = await once();
  // A veces la primera consulta falla o vuelve vacía; un reintento suele resolverlo
  if (retry && (!hits || !hits.length)) hits = await once();
  return (hits || []).filter(x => x.text && x.score >= 0.15).slice(0, 8);
}
let lastSearchError = '';

const DIALOG_RULES = `MODO DIÁLOGO: ahora no hay público. Estás conversando a solas con la persona que conduce las presentaciones de SIEMA. Esta regla reemplaza a la de no suponer quién habla.
- Respondé como en una charla: una a tres frases, directo al punto. La primera frase, corta (menos de quince palabras), para que se escuche enseguida. Si el tema lo pide, ofrecé profundizar en una frase al final ("¿querés que te cuente el detalle por provincia?"), sin repetirlo en cada respuesta.
- Recordá lo que se dijo antes en la conversación y retomalo con naturalidad.
- Si te pide ayuda para preparar una presentación (cómo explicar algo, qué preguntas podría hacer el público, cómo mejorar una respuesta, qué dato usar), ayudá con ejemplos concretos y breves, como un colega.
- Si te pide más detalle, extendete lo necesario.
- En este modo NO hay subtítulos: escribí solo la respuesta que vas a decir. No agregues la marca ### ni la traducción (esto reemplaza la regla de formato de salida).`;

const TEXT_RULES = `MODO ESCRITO: tu respuesta se lee en pantalla, en el chat del sitio de SIEMA. Nadie la escucha: no hay voz ni subtítulos.
- Respondé por escrito, claro y completo, en unas 120 a 250 palabras salvo que la pregunta pida más detalle.
- Escribí siempre las cifras con números, unidades y símbolos (5,3 sobre 10; 8 %; US$ 6.394 M; 500 kV; 291 kt/año). La base de conocimiento trae muchas cifras escritas como se dicen en voz alta ("cinco coma tres", "ocho por ciento", "quinientos kilovoltios"): pasalas a números y símbolos, sin cambiar el valor.
- Usá párrafos cortos y, si ayuda, una lista breve con guiones. Nada de títulos ni tablas.
- Si los datos tienen fecha, indicala (por ejemplo, "a octubre de 2026").
- Terminá siempre con una línea aparte que empiece con "Fuentes:" (o "Sources:" en inglés) y nombre de dónde salen los datos de forma reconocible (SIEMA, Secretaría de Minería, informe técnico de la empresa, Boletín Oficial, prensa sectorial). Nunca nombres archivos ni rutas.
- No agregues la marca ### ni traducción.`;

// Recordatorio que va al final de las instrucciones en modo escrito (lo último que lee el modelo)
const TEXT_REMINDER = 'Recordá: esta respuesta es POR ESCRITO. Cifras con números y símbolos (no en palabras), párrafos cortos y, al final, la línea "Fuentes:".';

let knowledgeCache = { text: '', at: 0 };

async function getKnowledge(env) {
  const now = Date.now();
  if (knowledgeCache.text && now - knowledgeCache.at < 10 * 60 * 1000) return knowledgeCache.text;
  try {
    const r = await fetch(env.KNOWLEDGE_URL || DEFAULTS.KNOWLEDGE_URL, { cf: { cacheTtl: 600 } });
    if (r.ok) knowledgeCache = { text: await r.text(), at: now };
  } catch (e) { /* se usa la última copia */ }
  return knowledgeCache.text || 'Base de conocimiento no disponible en este momento.';
}

function cors(env, origin) {
  const allowed = env.ALLOWED_ORIGIN || DEFAULTS.ALLOWED_ORIGIN;
  const ok = origin === allowed || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || '');
  return {
    'Access-Control-Allow-Origin': ok ? origin : allowed,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const h = cors(env, origin);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: h });
    if (request.method === 'GET' && url.pathname === '/health') {
      const k = String(env.ANTHROPIC_API_KEY || '');
      // Diagnóstico sin revelar la clave: solo el tipo (prefijo público), el largo y si tiene espacios o comillas
      const keyInfo = { tipo: (k.match(/^sk-ant-[a-z]+\d*-/) || ['desconocido'])[0], largo: k.length, espacios: /\s/.test(k), comillas: /["']/.test(k) };
      return new Response(JSON.stringify({ ok: true, version: VERSION, key: !!env.ANTHROPIC_API_KEY, keyInfo, workspace: !!env.ANTHROPIC_WORKSPACE_ID, library: !!(env.DOCS || env.AI), model: env.MODEL || DEFAULTS.MODEL }), { headers: { ...h, 'Content-Type': 'application/json' } });
    }
    if (request.method !== 'POST' || url.pathname !== '/ask') return new Response('Not found', { status: 404, headers: h });
    if (h['Access-Control-Allow-Origin'] !== origin) return new Response('Origen no permitido', { status: 403, headers: h });
    if (!env.ANTHROPIC_API_KEY) return new Response('Falta ANTHROPIC_API_KEY', { status: 500, headers: h });

    let body;
    try { body = await request.json(); } catch (e) { return new Response('JSON inválido', { status: 400, headers: h }); }
    // Solo los últimos 8 turnos, con texto acotado
    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-8)
      .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }))
      // Se descartan las respuestas de respaldo sin conexión que hayan quedado en la conversación
      .filter(m => !(m.role === 'assistant' && /sin conexi[oó]n|I am offline|I'm offline/i.test(m.content)))
      // y se unen los turnos seguidos del mismo rol que quedan al quitarlas
      .reduce((acc, m) => { const last = acc[acc.length - 1]; if (last && last.role === m.role) last.content += '\n' + m.content; else acc.push(m); return acc; }, []);
    if (!messages.length || messages[messages.length - 1].role !== 'user') return new Response('Falta la pregunta', { status: 400, headers: h });
    // La API exige que la conversación empiece con el usuario: si Kuntur abrió saludando
    // (botón "Nueva persona"), se antepone una nota de contexto
    if (messages[0].role === 'assistant') messages.unshift({ role: 'user', content: '(Se acerca al micrófono una persona del público.)' });

    if (body.debug) {
      // Diagnóstico: solo títulos de fuente y puntajes, sin texto ni llamada a Claude
      const hits = await searchLibrary(env, messages);
      const list = hits.map(x => ({ score: Math.round(x.score * 1000) / 1000, fuente: ((x.text.match(/\[Fuente: ([^\]—]+)/) || [])[1] || x.src).trim() }));
      return new Response(JSON.stringify(list.length ? list : { vacio: true, error: lastSearchError }, null, 1), { headers: { ...h, 'Content-Type': 'application/json' } });
    }
    const dlg = body.modo === 'dialogo';
    // En diálogo la biblioteca tiene un tope de tiempo corto: si no llega, Kuntur responde con la base de SIEMA
    const [knowledge, hits] = await Promise.all([getKnowledge(env), searchLibrary(env, messages, dlg ? { budget: 1800, retry: false } : {})]);
    const system = [
      { type: 'text', text: PERSONA },
      { type: 'text', text: 'BASE DE CONOCIMIENTO DE SIEMA:\n\n' + knowledge, cache_control: { type: 'ephemeral' } }
    ];
    const txt = body.modo === 'texto';
    system.push({ type: 'text', text: txt ? TEXT_RULES : VOICE_RULES });
    if (dlg) system.push({ type: 'text', text: DIALOG_RULES });
    if (hits.length) {
      const docs = hits.map((x, i) => `[Fragmento ${i + 1}]\n${x.text.slice(0, 2500)}`).join('\n\n');
      system.push({ type: 'text', text: LIBRARY_RULES + '\n\nFRAGMENTOS DE LA BIBLIOTECA (relevantes para esta pregunta):\n\n' + docs });
    }
    if (txt) system.push({ type: 'text', text: TEXT_REMINDER });
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: Object.assign({
        // Authorization: Bearer sirve para todas las claves (las de espacio de trabajo sk-ant-api… y las personales sk-ant-usr…)
        'authorization': 'Bearer ' + String(env.ANTHROPIC_API_KEY).trim(),
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      }, env.ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': String(env.ANTHROPIC_WORKSPACE_ID).trim() } : {}),
      body: JSON.stringify({
        model: env.MODEL || DEFAULTS.MODEL,
        max_tokens: txt ? 1500 : 900,
        stream: true,
        output_config: { effort: 'low' },
        thinking: { type: 'between_tools' },
        system,
        messages
      })
    });

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '');
      return new Response('Error de la API: ' + upstream.status + ' ' + detail.slice(0, 300), { status: 502, headers: h });
    }

    // Convierte el streaming de Anthropic en texto plano incremental
    const { readable, writable } = new TransformStream();
    (async () => {
      const writer = writable.getWriter();
      const enc = new TextEncoder();
      const reader = upstream.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            try {
              const ev = JSON.parse(line.slice(5));
              if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') await writer.write(enc.encode(ev.delta.text));
            } catch (e) { /* línea parcial */ }
          }
        }
      } finally { await writer.close(); }
    })();

    return new Response(readable, { headers: { ...h, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
};
