<<<<<<< HEAD
# Ontime_Cocinas
Mueble de cocina y closets _ N8N Ai AGENTS atencion al cliente Mexico
=======
# Chatwoot — Reporte «Último mensaje saliente» por cliente

Aplicación web **estática** (HTML + JavaScript) servida por un **único proceso Node.js** que también hace de **proxy** hacia Chatwoot. Consulta la **API REST**, agrupa por **contacto** y muestra un tablero con el último mensaje **saliente** por cliente: **teléfono**, **asesor**, canal, estado, enlace a la conversación en el panel web de Chatwoot y exportación a **CSV**.

Puedes ejecutarla con **`node proxy-server.js`** o **Docker** (`Dockerfile` + `docker-compose.yml`).

---

## ¿Qué problema resuelve?

En Chatwoot las conversaciones están por canal/inbox. Este panel:

1. Lista conversaciones filtradas por **inbox** (sucursal/canal).
2. Para cada conversación, obtiene los **mensajes** y localiza el **último mensaje saliente** (`message_type` = saliente, no privado).
3. **Agrupa por contacto**: si un cliente tiene varias conversaciones, se conserva solo la fila cuya conversación tiene el saliente **más reciente**.
4. **Oculta** filas donde ese último saliente lo envió el usuario **Super Admin** (configurable en código en `app.js`).
5. Muestra **quién envió** ese mensaje (columna **Asesor**).
6. Genera el **enlace web** a la conversación en formato  
   `{tu_chatwoot}/app/accounts/{account}/inbox/{inbox}/conversations/{id}`.

---

## Estructura del proyecto

Vista habitual del repositorio (sin `node_modules`):

```
chatwoot_extraction/
├── app.js                 # Frontend: reporte, filtros, CSV y panel Supervisor AI
├── index.html             # UI y estilos
├── proxy-server.js        # Backend monolito: estáticos, proxy, OpenAI y Supabase
├── package.json           # Scripts npm y dependencias backend
├── package-lock.json      # Versiones instaladas
├── .env.example           # Variables necesarias
├── supabase-schema.sql    # Tabla de reportes del supervisor
├── Dockerfile             # Imagen Node Alpine + npm ci
├── docker-compose.yml     # Servicio, puertos y variables de entorno
├── .dockerignore          # Contexto de build reducido
└── README.md              # Esta documentación (también servible en /README.md vía proxy-server)
```

| Entrega | Rol |
|---------|-----|
| **`index.html`** | Página única: configuración, estadísticas, IDs de conversaciones, buscador, tabla paginada, estilos embebidos y panel **Supervisor AI**. |
| **`app.js`** | Frontend: obtiene reporte operativo actual, resuelve proxy, exporta CSV y llama a `/api/supervisor/*` para análisis AI. |
| **`proxy-server.js`** | Backend: sirve archivos estáticos, mantiene proxy `/chatwoot/*`, analiza conversaciones con OpenAI y guarda/lee reportes en Supabase. |
| **`package.json`** | Scripts `start` y `check`; dependencias `dotenv`, `openai`, `@supabase/supabase-js`. |
| **`.env.example`** | Plantilla de secretos/configuración: Chatwoot, OpenAI, Supabase. |
| **`supabase-schema.sql`** | SQL para crear `conversation_supervision_reports`. |
| **`Dockerfile`** | `node:22-alpine`, instala dependencias con `npm ci`, copia frontend/backend y expone `3001`. |
| **`docker-compose.yml`** | Build local, publicación de puertos y variables para Chatwoot/OpenAI/Supabase. |
| **`.dockerignore`** | Excluye `.git`, otros compose, etc., del contexto de `docker build`. |

Dependencias backend: módulos estándar de Node más `dotenv`, `openai` y `@supabase/supabase-js`.

---

## ¿Para qué sirve `proxy-server.js`?

Los navegadores aplican **CORS** (Cross-Origin Resource Sharing). Si abres `index.html` desde tu PC y las peticiones van directamente a `https://app.ontime.chat` (u otra instancia), Chatwoot puede **no** enviar las cabeceras que permiten que una página en `file://` o en `http://localhost` lea la respuesta. El navegador bloquea la respuesta y la app falla.

El **servidor** (`proxy-server.js`):

1. Escucha en **`PORT`** (por defecto **3001**) y en **`HOST`** (por defecto **`0.0.0.0`**, apto para contenedores).
2. **Interfaz web**: `GET /` y `GET /index.html` sirven `index.html`; `GET /app.js` sirve el script. También se puede solicitar `README.md` y `supabase-schema.sql`.
3. **Proxy a Chatwoot**: rutas **`/chatwoot/...`** (ej. `/chatwoot/api/v1/accounts/1/conversations`).
4. Reconstruye la URL real anteponiendo la base de Chatwoot:
   - La base la manda el cliente en **`x-chatwoot-base-url`**.
   - Si falta, usa **`CHATWOOT_DEFAULT_BASE_URL`** (variable de entorno) o, si no está definida, `https://app.ontime.chat`.
5. Reenvía por **HTTP o HTTPS** según la URL configurada, con cabeceras mínimas (`api_access_token`, `accept`, `content-type` cuando aplique).
6. Expone endpoints **`/api/supervisor/*`** para salud, análisis con OpenAI y lectura de reportes Supabase.
7. En respuestas del proxy añade **`Access-Control-Allow-Origin: *`** para que no falle CORS si la UI y el proxy no son exactamente el mismo origen.

En resumen: puedes abrir **solo este servidor** (UI + proxy en el mismo puerto); el navegador habla con tu host y ese proceso habla con Chatwoot.

### Otras rutas

Fuera de las rutas estáticas permitidas y de `/chatwoot/*`, responde **404** en texto plano.

### Peticiones `OPTIONS`

Responde **204** para satisfacer **preflight** CORS.

### Cabeceras hacia Chatwoot

No reenvía todo el `req.headers` del navegador. Construye un conjunto acotado para evitar conflictos. La cabecera **`x-chatwoot-base-url`** solo la usa el proxy localmente y **no** se manda a Chatwoot.

---

## Cómo ejecutarlo

### 1. Con Node (recomendado)

Desde la carpeta del proyecto:

```bash
npm install
```

En Windows/PowerShell, crea y llena el `.env`:

```powershell
Copy-Item .env.example .env
```

Luego arranca:

```bash
npm start
```

Abre en el navegador **`http://127.0.0.1:3001/`** (misma app y mismo proxy).

Variables de entorno principales:

| Variable | Descripción |
|---------|-------------|
| `PORT` | Puerto HTTP (defecto `3001`). |
| `HOST` | Interfaz de escucha (defecto `0.0.0.0`). |
| `CHATWOOT_DEFAULT_BASE_URL` | Instancia Chatwoot por defecto si el cliente no envía `x-chatwoot-base-url`. |
| `CHATWOOT_ACCOUNT_ID` | Cuenta por defecto de Chatwoot para el backend supervisor. |
| `CHATWOOT_API_TOKEN` | Token server-side de Chatwoot; evita depender del token escrito en el navegador. |
| `AI_AGENT_SENDER_NAME` | Nombre del usuario de Chatwoot que representa al agente AI (defecto `Super Admin`). |
| `ARCHITECT_SENDER_NAMES` | Lista separada por comas de usuarios que cuentan como arquitectos humanos (`Manuel Limon,Kevin Landy,Israel Monge,Abigail Perez`). |
| `OPENAI_API_KEY` | API key para analizar conversaciones. |
| `OPENAI_MODEL` | Modelo usado por el supervisor (defecto `gpt-4o-mini`). |
| `SUPABASE_URL` | URL del proyecto Supabase. |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key para insertar/leer reportes desde backend. No va al navegador. |
| `SUPABASE_REPORTS_TABLE` | Tabla destino (defecto `conversation_supervision_reports`). |

Antes de usar Supabase, ejecuta **`supabase-schema.sql`** en el SQL Editor del proyecto.

### 2. Docker

Construir y levantar: el Compose publica **dos** puertos hacia el mismo servicio interno **3001**:

- **`http://localhost:8080/`** (o el que definas con `HOST_PORT`)
- **`http://127.0.0.1:3001/`** (así sigue funcionando si en «Proxy local» tienes `http://127.0.0.1:3001`)

```bash
docker compose up --build
```

**Recomendado:** abre **`http://localhost:8080/`** y deja **Proxy local** **vacío**. Así las peticiones van a `http://localhost:8080/chatwoot/...` y no dependen del puerto 3001 del host.

Si entras por **8080** pero dejas el proxy en **3001** y **no** tienes nada escuchando en `127.0.0.1:3001` del PC (antes solo mapeabas `8080:3001`), el navegador devuelve **`ERR_CONNECTION_REFUSED`**. Solución: proxy vacío, o usa el `docker-compose` actual que también expone **3001:3001**, o pon en Proxy la misma base que la barra de direcciones (ej. `http://localhost:8080`).

Otros puertos:

```bash
HOST_PORT=9090 docker compose up --build
```

*(El mapeo `3001:3001` sigue activo; si choca con un `node proxy-server.js` local en 3001, comenta esa línea en `docker-compose.yml`.)*

Opcional: fijar la instancia por defecto del servidor:

```bash
CHATWOOT_DEFAULT_BASE_URL=https://app.ontime.chat docker compose up --build
```

Solo imagen, sin Compose:

```bash
docker build -t chatwoot-dashboard .
docker run -p 8080:3001 -p 3001:3001 chatwoot-dashboard
```

Abre `http://localhost:8080/` con **Proxy local** vacío, o `http://127.0.0.1:3001/` con el mismo criterio.

### 3. Sin el servidor Node

- Abrir **`index.html`** directamente (`file://`) o con otro servidor estático **sin** proxy suele fallar por **CORS** al llamar a Chatwoot, salvo que indiques un proxy accesible en el campo correspondiente.

### 4. Configuración en pantalla

| Campo | Descripción |
|-------|-------------|
| **URL de Chatwoot** | Origen de tu instancia, sin barra final (ej. `https://app.ontime.chat`). |
| **API Token** | Token de usuario con acceso a la API (header `api_access_token`). |
| **Account ID** | ID numérico de la cuenta en Chatwoot. |
| **Máx. conversaciones** | Tope de conversaciones a analizar (paginación interna de la app). |
| **Sucursal / Canal** | Filtra por `inbox_id` (valores predefinidos en el HTML; puedes ampliarlos). |
| **Proxy local** | URL base del proxy (ej. `http://127.0.0.1:3001`). **Si lo dejas vacío** y abres la app por **http/https** (incluido Docker en `localhost`), se usa **el mismo origen** automáticamente. Si estás en `file://` y lo dejas vacío, las peticiones van **directo** a Chatwoot (habitualmente bloqueado por CORS). |

Pulsa **Obtener reporte** para cargar datos.

Panel **Supervisor AI**:

- **Analizar con AI** llama a `POST /api/supervisor/analyze`: lista solo conversaciones del inbox con **actividad en las últimas 24 h** (configurable con `CHATWOOT_ACTIVITY_WINDOW_HOURS`), trae de Chatwoot **solo los mensajes de esa ventana** y combina el análisis con el **historial guardado en Supabase** (reporte previo, métricas, resumen). Etiqueta conversaciones con **más de 2 días sin interacción** e interés comercial real. También guarda un snapshot del día.
- **Ver reportes** abre la pestaña Reportes (`GET /api/supervisor/reports`).
- **Seguimiento diario** compara snapshots de hoy vs ayer para conversaciones en etapas `asesor_ventas` y `cotizacion_pendiente`.
- El análisis AI solo consulta Chatwoot para **actividad reciente** (`CHATWOOT_ACTIVITY_WINDOW_HOURS`, defecto 24). El umbral de inactividad: `INACTIVE_DAYS_THRESHOLD` (defecto 2). Opcional: `SUPERVISOR_MAX_CONVERSATIONS` y `SUPERVISOR_MAX_CONVERSATION_PAGES`.

### ¿Cómo combina Chatwoot (24 h) con el histórico en Supabase?

#### 1. ¿Une las últimas 24 h de Chatwoot con el histórico de la BD para el análisis AI?

**Sí**, cuando ya existe un reporte previo en Supabase para esa `conversation_id`.

Flujo en `POST /api/supervisor/analyze`:

**Chatwoot** (ventana configurable, por defecto 24 h)

- Lista conversaciones del inbox con actividad reciente (`fetchConversationsWithRecentActivity`).
- Por cada una, trae solo mensajes de esas últimas 24 h (`fetchRecentConversationMessages`).

**Supabase** (histórico por cliente/conversación)

- Lee el reporte anterior (`fetchPreviousReport` → tabla `conversation_supervision_reports`).
- Construye contexto histórico (`buildStoredHistoricalContext`): resumen, recomendación, etapa, métricas, cotización previa, análisis de ventas, etc.

**Fusión antes de mandar a OpenAI**

- `mergeMetricsForAnalysis`: combina métricas guardadas + las de la ventana reciente.
- `buildAnalysisEnrichment`: envía a la IA:
  - **Transcript reciente** → mensajes de Chatwoot de las últimas 24 h.
  - **Histórico resumido** → texto armado desde el reporte previo en BD (`narrative_for_ai`), no el chat entero.
- También usa snapshots de seguimiento (`conversation_followup_snapshots`) si existen.

**Primera vez** (sin reporte en BD): solo analiza con lo traído de Chatwoot en esas 24 h; no hay histórico previo que unir.

**Requisito:** Supabase configurado (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`). Sin eso, no hay lectura ni guardado de histórico.

#### 2. ¿Lo nuevo de cada ~24 h queda guardado en el contexto de cada cliente?

**Sí se guarda**, pero **no como archivo de mensajes acumulado**. Se guarda así:

| Qué se guarda | Dónde | Qué implica |
|--------------|-------|-------------|
| Reporte actualizado (upsert por `conversation_id`) | `conversation_supervision_reports` | Reemplaza/actualiza un registro por conversación: nuevo `summary`, `recommendation`, `stage`, `raw_analysis`, `metrics`, etc. |
| Métricas fusionadas | Campo `metrics` (JSON) | Incluye conteos, fechas, cotización, tags, `fetch_mode`, cuántos mensajes se trajeron en la ventana, etc. |
| Snapshot del día | `conversation_followup_snapshots` | Un snapshot por conversación y fecha (actividad del día). |

**No se guardan** en BD todos los mensajes de Chatwoot línea por línea. Los mensajes de las 24 h se usan para el análisis; lo que queda persistente es sobre todo el **resultado del análisis** y las **métricas**, no un transcript histórico completo.

En la **siguiente** ejecución, el “histórico” que lee la IA es ese **resumen del análisis anterior** (`buildStoredHistoricalContext`), más los **mensajes nuevos** de las siguientes 24 h. El contexto **crece por resúmenes y métricas**, no por copia acumulativa de cada mensaje antiguo.

#### Resumen práctico

| Pregunta | Respuesta |
|----------|-----------|
| ¿24 h + histórico BD para AI? | **Sí**, si ya hay reporte en Supabase. |
| ¿Histórico = chat completo? | **No**; es resumen/análisis previo + métricas + snapshots. |
| ¿Lo nuevo queda guardado? | **Sí**, al terminar el análisis (`storeReports` + snapshot), si Supabase está activo. |
| ¿Se acumulan mensajes crudos cada día? | **No**; se actualiza el reporte y el snapshot del día. |

> Si en el futuro quisieras que el histórico incluya **todos los mensajes** guardados en BD (no solo resúmenes), habría que ampliar el esquema o guardar transcripts en `metrics` — eso **no está implementado** hoy.

---

## Endpoints de la API que usa `app.js`

- **Listado de conversaciones** (por cuenta, inbox y página):  
  `GET /api/v1/accounts/{accountId}/conversations?inbox_id=...&page=...`
- **Mensajes de una conversación**:  
  `GET /api/v1/accounts/{accountId}/conversations/{conversationId}/messages`

Con proxy, la URL efectiva es:

`{proxyUrl}/chatwoot/api/v1/...`  
más la cabecera `x-chatwoot-base-url: https://tu-instancia`.

### Logging y depuración (Supervisor AI)

Cada ejecución de **Analizar con AI** genera un `run_id` con pasos, tiempos y tamaño del payload hacia OpenAI.

| Dónde verlo | Uso |
|-------------|-----|
| **Consola del servidor** | Líneas `[INFO]` / `[WARN]` / `[ERROR]` con paso y `duration_ms` |
| **Panel «Log de ejecución»** en la UI | Tras analizar, debajo del botón (eventos del run) |
| **Respuesta JSON** | Campos `run_id` y `debug` (eventos completos si `debug: true` en el body) |
| **`GET /api/supervisor/logs`** | Lista de runs recientes en memoria |
| **`GET /api/supervisor/logs/{run_id}`** | Detalle de un run |
| **Archivo** (opcional) | `SUPERVISOR_LOG_TO_FILE=true` → `./logs/supervisor-YYYY-MM-DD.log` |

**Pasos registrados (ejemplos):** `chatwoot_list_conversations`, `chatwoot_request` / `chatwoot_response_ok`, `conv_{id}_chatwoot_recent_messages`, `conv_{id}_supabase_previous_report`, `openai_chat_completion`, `llm_payload_large` (si el JSON supera el umbral), `supabase_store_reports`.

Variables en `.env`:

```env
SUPERVISOR_LOG_LEVEL=info          # debug | info | warn | error
SUPERVISOR_LOG_TO_FILE=false
SUPERVISOR_LOG_DIR=logs
SUPERVISOR_LLM_WARN_CHARS=80000    # aviso si el prompt es muy grande
SUPERVISOR_LLM_ERROR_CHARS=120000
```

Si parece **pegado en el LLM**, busca en el log `openai_chat_completion_start` sin el `_done` correspondiente, o `openai_slow_response` (&gt; 60 s). Si **Chatwoot falló**, verás `chatwoot_http_error` con `status` y vista previa del cuerpo.

### Endpoints backend del supervisor

- **Salud/configuración**: `GET /api/supervisor/health`
- **Analizar y guardar**: `POST /api/supervisor/analyze`
- **Logs recientes**: `GET /api/supervisor/logs`
- **Detalle de un run**: `GET /api/supervisor/logs/{run_id}`
- **Leer reportes**: `GET /api/supervisor/reports?limit=20`
- **Seguimiento (diff)**: `GET /api/supervisor/followup?inbox_id=49&stages=asesor_ventas,cotizacion_pendiente`
- **Sincronizar snapshots hoy**: `POST /api/supervisor/followup/sync`

Ejecuta el SQL de `conversation_followup_snapshots` en `supabase-schema.sql` antes de usar seguimiento.

`POST /api/supervisor/analyze` acepta JSON:

```json
{
  "baseUrl": "https://app.ontime.chat",
  "accountId": "1",
  "inboxId": "49",
  "branchName": "HmoOntime",
  "activityWindowHours": 24,
  "token": "opcional-si-no-hay-CHATWOOT_API_TOKEN"
}
```

La respuesta incluye `reports`, `errors`, `stored`, `activity_window_hours`, `pages_scanned` y conteos. Si Supabase no está configurado, el análisis puede regresar reportes en memoria, pero no los persiste ni reutiliza histórico.

---

## Comportamiento del reporte

- **Último saliente**: entre los mensajes con `message_type === 1` y no privados, se toma el de **fecha más reciente** según `created_at`.
- **Filtro Super Admin**: no se muestran filas cuyo último saliente tiene como remitente visible el nombre **Super Admin** (comparación sin distinguir mayúsculas; constante `OUTBOUND_SENDER_EXCLUDE` en `app.js`).
- **Asesor**: nombre tomado de `sender.available_name`, `sender.name` o `sender.email` en el mensaje.
- **Teléfono**: `phone_number` del contacto en la conversación (`meta.sender` / `contact`).
- **Columnas de la tabla** (orden aproximado): Cliente · Teléfono · Último msg. saliente · Asesor · Canal/Inbox · Estado · Enlace Conversación · Dir.
- **Enlace “Conversación”**: se construye con la URL base configurada, `accountId`, `inbox_id` de la conversación (o el inbox seleccionado si faltara) e `id` de conversación.
- **Estadísticas**: totales sobre las filas ya filtradas (sin Super Admin).
- **CSV**: exporta las filas visibles tras búsqueda y orden, incluyendo URL de conversación.
- **IDs de conversaciones**: lista todos los IDs obtenidos en el listado inicial (antes del agrupado por contacto); no coincide fila a fila con “una fila = una conversación” del mapa final.
- **Supervisor AI**: clasifica etapa, riesgo, score, alertas, etc. **Cotización enviada** se confirma de forma determinística si en el chat aparece un enlace con dominio oficial por sucursal: `obregon.ontimecocinas.com`, `nogales.ontimecocinas.com` / `nogales.ontimecocibas.com`, `hermosillo.ontimecocinas.com` (prioriza mensajes salientes). La IA complementa seguimiento y atención pero no puede contradecir una URL detectada.
- **Seguimiento diario**: `Sincronizar hoy` guarda un snapshot por `conversation_id` y fecha (zona `FOLLOWUP_TIMEZONE`). La vista compara hoy vs ayer: seguimiento humano hoy (arquitecto o asesor, no solo AI), cliente sin respuesta, actividad nueva, etc.
- **Separación AI Agent vs Arquitecto**: todo mensaje saliente enviado por `AI_AGENT_SENDER_NAME` (por defecto **Super Admin**) se evalúa como **AI Agent**. Solo los usuarios definidos en `ARCHITECT_SENDER_NAMES` se evalúan como **arquitectos humanos**: Manuel Limon, Kevin Landy, Israel Monge y Abigail Perez. Otros usuarios salientes quedan como asesores no catalogados y no se mezclan con el bloque Arquitecto.

---

## Requisitos

- Navegador actual.
- **Node.js 20+** (las dependencias de Supabase requieren Node moderno) o **Docker**.
- Proyecto Supabase con la tabla de `supabase-schema.sql`.
- API key de OpenAI para el panel Supervisor AI.
- **Supabase Auth** (correo/contraseña) para acceder a la aplicación si `AUTH_REQUIRED=true`.

## Inicio de sesión (Supabase Auth)

La app incluye **`login.html`**: los usuarios deben autenticarse antes de usar el dashboard y las APIs protegidas.

### Configuración en Supabase

1. En el proyecto Supabase → **Authentication** → **Providers** → activa **Email**.
2. **Authentication** → **Users** → **Add user** (correo y contraseña) para cada persona del equipo.
3. En **Project Settings** → **API**, copia:
   - **Project URL** → `SUPABASE_URL`
   - **anon public** → `SUPABASE_ANON_KEY` (segura para el navegador con RLS; aquí solo se usa para login)
   - **service_role** → `SUPABASE_SERVICE_ROLE_KEY` (solo servidor, nunca en el frontend)

### Variables en `.env`

```env
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOi...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...
AUTH_REQUIRED=true
```

Para **desarrollo local sin login**: `AUTH_REQUIRED=false` (no recomendado en producción).

### Rutas

| Ruta | Descripción |
|------|-------------|
| `/login.html` | Página de inicio de sesión |
| `/` | App principal (redirige a login si no hay sesión) |
| `GET /api/auth/config` | Config pública para el cliente (URL + anon key) |
| `GET /api/auth/session` | Valida el JWT enviado en `Authorization: Bearer …` |

Con sesión activa, el navegador envía el **access token** de Supabase en las llamadas a `/api/supervisor/*` y al proxy `/chatwoot/*`.

---

## Personalización rápida

- **Puerto / host**: variables de entorno `PORT` y `HOST` (ver arriba); en código hay valores por defecto.
- **URL Chatwoot por defecto en el servidor**: `CHATWOOT_DEFAULT_BASE_URL` o el valor por defecto en `proxy-server.js`.
- **Modelo OpenAI**: `OPENAI_MODEL`.
- **Ventana de actividad Chatwoot**: `CHATWOOT_ACTIVITY_WINDOW_HOURS` (defecto 24), `CHATWOOT_RECENT_MESSAGES_MAX_PAGES`.
- **Transcript en análisis incremental**: el histórico largo viene de Supabase (resumen); los mensajes recientes de Chatwoot usan `MAX_TRANSCRIPT_CHARS` si el lote de 24 h es muy grande.
- **Nombre del AI Agent**: `AI_AGENT_SENDER_NAME`.
- **Arquitectos humanos**: `ARCHITECT_SENDER_NAMES`.
- **Tabla Supabase reportes**: `SUPABASE_REPORTS_TABLE`.
- **Tabla snapshots seguimiento**: `SUPABASE_SNAPSHOTS_TABLE`.
- **Etapas con seguimiento**: `FOLLOWUP_STAGES` (defecto `asesor_ventas,cotizacion_pendiente`).
- **Zona horaria seguimiento**: `FOLLOWUP_TIMEZONE` (defecto `America/Hermosillo`).
- **Agente a excluir del dashboard**: `OUTBOUND_SENDER_EXCLUDE` en `app.js`.
- **Inboxes en el desplegable**: etiquetas `<option>` de `#cw-branch` en `index.html` y el mapa `BRANCH_NAME_BY_ID` en `app.js`.

---

## Limitaciones y notas

- El rendimiento depende del número de conversaciones: por cada una se hace al menos una petición de mensajes (secuencial en el bucle).
- El análisis AI tiene costo por tokens; el volumen depende de cuántas conversaciones tuvieron actividad en las últimas 24 h (`CHATWOOT_ACTIVITY_WINDOW_HOURS`).
- Si Chatwoot no devuelve `sender` en algún mensaje, el **Asesor** puede quedar vacío y el filtro de Super Admin no aplicará en ese caso.
- La seguridad de `CHATWOOT_API_TOKEN`, `OPENAI_API_KEY` y `SUPABASE_SERVICE_ROLE_KEY` es responsabilidad tuya: no los subas a repositorios públicos. Deben vivir en `.env` o variables del entorno.

---

## Licencia / uso

Uso interno para integrar con vuestra instancia de Chatwoot (On time cocinas / Ontime). Ajustad URLs, tokens y cuentas según vuestro entorno.
>>>>>>> d9b5569 (Deploy AI Supervisor to Easypanel)
