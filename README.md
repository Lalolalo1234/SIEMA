# SIEMA — Sistema de Inteligencia Estratégica Minera Argentina

Plataforma de información, análisis y prospectiva del sector minero argentino, organizada en tres productos:

1. **Observatorio** — qué está pasando: oferta, demanda, Argentina hoy, capital humano y brechas.
2. **Pulsómetro** — cómo está el sector hoy: clima de inversión (consola con radar de 10 ejes), percepción externa, RIGI minero y Monitor MIMA.
3. **Prospectiva** — qué ocurrirá hasta 2050: modelo de escenarios Convergencias 2050.

Más **Noticias y eventos** (noticias, agenda de eventos de la base CeProMinDB e infografías) y **Acerca de**.

Una iniciativa del Centro Argentino de Ingenieros (CAI), Panorama Minero (PM) y la Universidad de Buenos Aires (UBA).

## Estructura

| Archivo | Contenido |
|---|---|
| `index.html` | El sitio completo (ES/EN), sin paso de compilación |
| `convergencias-2050.html` | Modelo de prospectiva embebido en la pestaña Prospectiva |
| `eventos.js` | Agenda de eventos (base CeProMinDB + agregados SIEMA) |
| `img/` | Imágenes e infografías |

Las cotizaciones y noticias en vivo se leen de la API en Cloudflare Workers (`SIEMA_API_BASE` en `index.html`); si no responde, el sitio usa valores de respaldo.

Publicado con GitHub Pages desde la rama `main`.
