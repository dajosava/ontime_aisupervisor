# Playbook Supervisor Ontime — v2 (cliente)

Documento de referencia humana. La versión ejecutada en código es `supervisor/playbook.js` con `SUPERVISOR_PLAYBOOK_VERSION=v2`.

## Fuente de verdad del prompt

| Recurso | Uso |
|---------|-----|
| [`supervisor/prompts/supervisor-ontime-v2.md`](prompts/supervisor-ontime-v2.md) | Texto completo del playbook (objetivo, CERRAR, castigos lead/asesor_venta) |
| [`supervisor/playbook.js`](playbook.js) | Carga el `.md` + flujo de herramientas en runtime |
| [`supervisor/analysis-normalize.js`](analysis-normalize.js) | Valida JSON de salida (`evaluation_scope`, scores, fuera_de_alcance) |

## Alcance de evaluación

| Etapa | Acción |
|-------|--------|
| `lead` | Evaluar con C, E, R (captó intención, entendió necesidad, respondió con dirección) |
| `asesor_venta` | Evaluar CERRAR completo |
| Posventa, diseño, instalación, garantía, cobranza, etc. | `fuera_de_alcance` — `score_general: null`, sin análisis comercial largo |

## Reglas de negocio (código, no negociables)

- **No resumir** la conversación: evaluación comercial con evidencia breve.
- **Cotización enviada**: URL oficial `*.ontimecocinas.com` (`compute_business_facts`).
- **Inactiva con interés**: etiqueta `inactiva_interes_real` si aplica.
- **Etiquetas Chatwoot excluidas**: conversaciones con etiquetas de la lista configurada **no se analizan** (`services/chatwoot-labels.service.js`).

## Participantes

- **AI Agent**: `AI_AGENT_SENDER_NAME` (configurable en UI o `.env`).
- **Arquitectos humanos**: lista en Configuración del agente / `ARCHITECT_SENDER_NAMES`.
- **Otros salientes**: asesor no catalogado.

## Flujo agente (herramientas)

1. `get_previous_report`
2. `get_recent_messages`
3. `get_snapshot_history` (opcional)
4. `compute_business_facts`
5. `submit_supervision_analysis`

Límites: `SUPERVISOR_AGENT_MAX_ROUNDS`, `SUPERVISOR_AGENT_MAX_TOOLS_PER_ROUND` (también editables en UI).

## Salida JSON (v2)

Campos destacados: `evaluation_scope`, `evaluation_stage`, `cerrar_evaluation`, `lead_checklist`, `castigos_aplicados`, `venta_pasiva_detectada`, análisis AI/arquitecto, `sales_process_analysis`.

## Playbook v1 (legacy)

Si necesitas el comportamiento anterior: `SUPERVISOR_PLAYBOOK_VERSION=v1` y documentación en [`playbook-v1.md`](playbook-v1.md).
