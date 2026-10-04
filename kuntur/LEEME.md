# Kuntur — puesta en marcha

Kuntur es el asistente de SIEMA que presenta la plataforma y responde preguntas en voz alta. La página es `kuntur.html`: <https://lalolalo1234.github.io/SIEMA/kuntur.html>

Funciona en dos modos:

- **Sin conexión (ya funciona):** da la presentación completa y responde con respuestas preparadas sobre los temas principales (RIGI, litio, cobre, licencia social, macro, infraestructura, capital humano, prospectiva, Pulsómetro, SIEMA). No necesita nada más.
- **Con Claude (respuestas libres):** responde cualquier pregunta con Claude, usando la base de conocimiento `kuntur/conocimiento.md`. Necesita los tres pasos de abajo, una sola vez.

## 1. Clave de la API de Anthropic (unos 5 minutos)

1. Entrá a <https://console.anthropic.com> y creá una cuenta.
2. En **Billing**, cargá crédito. Con 5 dólares alcanza de sobra para ensayos y la conferencia: cada respuesta cuesta alrededor de un centavo.
3. En **Limits**, poné un límite mensual de gasto bajo (por ejemplo, 10 dólares). Así nada puede costar más de eso.
4. En **API Keys**, hacé clic en **Create Key**, ponele de nombre "Kuntur" y copiá la clave. Empieza con `sk-ant-`. Guardala: no se vuelve a mostrar.

## 2. Servicio en Cloudflare (unos 10 minutos)

Usa la misma cuenta de Cloudflare del servicio de cotizaciones de OMA. Todo se hace en el navegador, sin instalar nada.

1. En <https://dash.cloudflare.com>, andá a **Workers & Pages** → **Create** → **Create Worker**.
2. Ponele de nombre `kuntur` y hacé clic en **Deploy**.
3. Hacé clic en **Edit code**. Borrá todo el código de ejemplo, pegá el contenido completo de `kuntur/worker.js` y hacé clic en **Deploy**.
4. Volvé al worker → **Settings** → **Variables and Secrets** → **Add**:
   - Tipo **Secret**, nombre `ANTHROPIC_API_KEY`, valor: la clave del paso 1.
   - Guardá con **Deploy**.
5. Copiá la dirección del worker. Se ve como `https://kuntur.TU-CUENTA.workers.dev`.

## 3. Conectar la página

1. Abrí <https://lalolalo1234.github.io/SIEMA/kuntur.html> en **Microsoft Edge** o **Google Chrome**.
2. Hacé clic en **Encender a Kuntur** y presioná **S** (Ajustes).
3. Pegá la dirección del worker en **Dirección del servicio de respuestas** y hacé clic en **Probar conexión**. Tiene que decir "Conectado".

La dirección queda guardada en ese navegador. En otra computadora, repetí este paso o abrí la página con `?api=` y la dirección, por ejemplo `kuntur.html?api=https://kuntur.TU-CUENTA.workers.dev`.

## En el escenario

| Tecla | Qué hace |
|---|---|
| P | Presentar SIEMA en español, con subtítulos en inglés (unos 4 minutos) |
| Mayús + P | Presentar en inglés, con subtítulos en español |
| → | Saltar a la siguiente parte de la presentación |
| Espacio | Escuchar una pregunta en español. Las pausas no la cortan: al terminar, presioná Espacio de nuevo o Enter (o esperá unos 3 segundos de silencio) |
| E | Escuchar una pregunta en inglés (se termina igual: E de nuevo o Enter) |
| T | Escribir una pregunta (por ejemplo, una que llegó del público) |
| Esc | Callar a Kuntur |
| F | Pantalla completa |
| S | Ajustes: voces, velocidad, tono y conexión |
| H | Atajos |

Recomendaciones:

- **Usá Microsoft Edge.** Trae voces naturales gratuitas en español e inglés ("Online (Natural)"), mucho mejores que las de Chrome. Elegilas en Ajustes y probalas.
- **Corrección automática:** Kuntur corrige lo que el reconocimiento de voz suele confundir ("Cantur" o "Contur" por Kuntur, "CIEMA" por SIEMA, "Rigui" por RIGI) y quita las muletillas ("eh", "um") antes de mostrar la pregunta.
- **Micrófono:** el navegador pide permiso la primera vez. En la sala, conviene un micrófono de mano o de solapa conectado a la computadora, no el de la laptop.
- **Internet:** el reconocimiento de voz y Claude necesitan conexión. Si se corta, Kuntur sigue con las respuestas preparadas, y siempre podés escribir la pregunta con T.
- **Ensayo:** hacé al menos una pasada completa en la computadora y la sala del evento.

## Actualizar lo que sabe Kuntur

Editá `kuntur/conocimiento.md` y publicalo en el repositorio. El servicio lo vuelve a leer cada 10 minutos. Para cambiar la presentación o las respuestas preparadas, editá `SCRIPT` y `FAQ` en `kuntur.html`.
