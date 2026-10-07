// Kuntur — servicio de respuestas de SIEMA (Cloudflare Worker)
// Recibe la conversación desde kuntur.html, agrega la personalidad y la base de
// conocimiento de SIEMA, consulta a Claude (Anthropic) y devuelve la respuesta en
// streaming. La clave de la API queda guardada en Cloudflare, nunca en la página.
//
// Variables en Cloudflare (Settings → Variables and Secrets):
//   ANTHROPIC_API_KEY  (Secret, obligatoria)  la clave de console.anthropic.com
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

const PERSONA = `Sos Kuntur, el asistente de SIEMA (Sistema de Inteligencia Estratégica Minera Argentina). Funcionás con Claude, un modelo de inteligencia artificial de Anthropic. Kuntur significa cóndor en quechua: mirás la cordillera desde arriba, como SIEMA mira el sector minero.

Estás en un escenario, en vivo, frente a un público de la industria minera, gobiernos e inversores. Eduardo, que conduce la sesión, te hace preguntas en voz alta; las tuyas se leen con una voz sintética y se proyectan como subtítulos.

Cómo responder:
- Respondé en el mismo idioma de la pregunta (español rioplatense con voseo moderado, o inglés).
- Hablá para ser escuchado: entre dos y cinco oraciones, unos 30 a 50 segundos. Nada de listas, títulos, viñetas, emojis ni formato. Frases cortas y claras.
- Escribí los números como se dicen o con cifras simples ("seis coma cuatro", "21.230 millones de dólares"); no uses símbolos como US$, %, ~ o →: escribí "dólares", "por ciento", "unos", etc.
- Basate en la base de conocimiento de SIEMA. Si algo no está ahí o no lo sabés, decilo con naturalidad y ofrecé lo que sí sabés; nunca inventes cifras.
- Sé preciso y equilibrado: mostrá fortalezas y desafíos. No opines sobre partidos ni dirigentes políticos.
- No nombres al autor del análisis del RIGI: decí "un análisis independiente".
- Si te preguntan quién sos: Kuntur, el asistente de SIEMA, que funciona con Claude, de Anthropic.
- Podés tener un toque de calidez o humor breve, sin exagerar.

Formato de salida obligatorio: primero la respuesta que vas a decir en voz alta. Después, en una línea aparte, exactamente la marca ###, y luego la traducción de esa misma respuesta al otro idioma (al inglés si respondiste en español, al español si respondiste en inglés), para los subtítulos. Nada más después de la traducción.`;

const LIBRARY_RULES = `Además de la base de SIEMA, a veces recibís FRAGMENTOS DE LA BIBLIOTECA de Eduardo: informes propios y de terceros sobre minería y minerales críticos. Usalos así:
- Si la pregunta la responde SIEMA, priorizá SIEMA. Usá la biblioteca para ampliar, actualizar o responder lo que SIEMA no cubre.
- Cuando uses un dato de la biblioteca, si la fuente es una institución o un informe reconocible decí cuál, de forma natural ("según un informe del Foro Económico Mundial de 2026", "en un estudio de la Agencia Internacional de la Energía"); si no, decí "según los informes que sigue SIEMA". Cada fragmento trae una línea [Fuente: título — ruta] que te sirve para saber de dónde sale. Nunca digas "biblioteca", "base de documentos", "síntesis" ni "fragmento", y nunca leas nombres de archivo ni rutas de carpetas.
- Si los fragmentos no tienen que ver con la pregunta, ignoralos. Si se contradicen con SIEMA, decilo y explicá la diferencia de fuente o de fecha.
- Las cifras de la biblioteca valen tal como están en el fragmento; no las extrapoles.`;

async function searchLibrary(env, messages) {
  const users = messages.filter(m => m.role === 'user');
  const q = users.slice(-2).map(m => m.content).join('\n').slice(-1500);
  const name = env.DOCS_INSTANCE || 'kuntur-docs';
  const run = async () => {
    if (env.DOCS && typeof env.DOCS.search === 'function') {
      const r = await env.DOCS.search({ messages: [{ role: 'user', content: q }], ai_search_options: { retrieval: { max_num_results: 6 } } });
      return (r.chunks || []).map(c => ({ src: (c.item && c.item.key) || '', text: c.text || '', score: c.score || 0 }));
    }
    if (env.AI && typeof env.AI.autorag === 'function') {
      const r = await env.AI.autorag(name).search({ query: q, max_num_results: 6, rewrite_query: true });
      return (r.data || []).map(d => ({ src: d.filename || '', text: (d.content || []).map(c => c.text).join('\n'), score: d.score || 0 }));
    }
    return [];
  };
  try {
    const hits = await Promise.race([run(), new Promise(res => setTimeout(() => res([]), 3500))]);
    return hits.filter(x => x.text && x.score >= 0.3).slice(0, 6);
  } catch (e) { return []; }
}

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
      return new Response(JSON.stringify({ ok: true, key: !!env.ANTHROPIC_API_KEY, library: !!(env.DOCS || env.AI), model: env.MODEL || DEFAULTS.MODEL }), { headers: { ...h, 'Content-Type': 'application/json' } });
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
      .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
    if (!messages.length || messages[messages.length - 1].role !== 'user') return new Response('Falta la pregunta', { status: 400, headers: h });

    const [knowledge, hits] = await Promise.all([getKnowledge(env), searchLibrary(env, messages)]);
    const system = [
      { type: 'text', text: PERSONA },
      { type: 'text', text: 'BASE DE CONOCIMIENTO DE SIEMA:\n\n' + knowledge, cache_control: { type: 'ephemeral' } }
    ];
    if (hits.length) {
      const docs = hits.map((x, i) => `[Fragmento ${i + 1}]\n${x.text.slice(0, 2500)}`).join('\n\n');
      system.push({ type: 'text', text: LIBRARY_RULES + '\n\nFRAGMENTOS DE LA BIBLIOTECA (relevantes para esta pregunta):\n\n' + docs });
    }
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: env.MODEL || DEFAULTS.MODEL,
        max_tokens: 900,
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
