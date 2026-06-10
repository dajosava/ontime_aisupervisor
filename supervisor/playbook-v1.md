# Playbook Supervisor Ontime — v1

Documento de referencia humana. La versión ejecutada en código es `supervisor/playbook.js` (`SUPERVISOR_PLAYBOOK_VERSION=v1`).

## Misión

Supervisar calidad comercial de conversaciones Chatwoot de **On Time Cocinas (México)**: embudo, riesgo, seguimiento, AI Agent vs arquitectos humanos.

## Fuentes de datos

| Fuente | Uso |
|--------|-----|
| Chatwoot (ventana 24h por defecto) | Mensajes recientes |
| Supabase `conversation_supervision_reports` | Resumen y métricas previas |
| Supabase `conversation_followup_snapshots` | Seguimiento día a día |

## Hechos (código, no opinión del LLM)

- **Cotización enviada**: detección por dominio oficial `*.ontimecocinas.com` por sucursal.
- **Inactiva con interés**: ≥ `INACTIVE_DAYS_THRESHOLD` días sin actividad + señales de interés comercial.

## Participantes

- **AI Agent**: usuario Chatwoot configurado (`AI_AGENT_SENDER_NAME`, p. ej. Super Admin).
- **Arquitectos**: lista `ARCHITECT_SENDER_NAMES`.
- **Otros salientes**: asesor no catalogado (no mezclar con arquitecto).

## Flujo agente (herramientas) — modo por defecto

Orquestado por `agent/process-conversation.js` → `agent/supervisor-agent.js`.

1. `get_previous_report`
2. `get_recent_messages`
3. `get_snapshot_history` (opcional)
4. `compute_business_facts`
5. `submit_supervision_analysis`

Límites: `SUPERVISOR_AGENT_MAX_ROUNDS`, `SUPERVISOR_AGENT_MAX_TOOLS_PER_ROUND`.

Si no hay `submit` a tiempo pero ya hay `compute_business_facts`, fallback a prompt JSON legacy con los mismos datos (`SUPERVISOR_AGENT_LEGACY_FALLBACK`).

Legacy opt-in: `SUPERVISOR_LEGACY_MODE=true` o `SUPERVISOR_AGENT_MODE=false`.

## Salida

JSON estructurado con etapa, riesgo, score, sentimiento, alertas, análisis AI/arquitecto, `sales_process_analysis`.
