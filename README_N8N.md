# Integración con n8n (Automatización)

Tu servidor MCP ahora tiene un "Cerebro IA" incorporado (Gemini) expuesto como una API REST simple. Esto hace que integrarlo con **n8n** sea trivial.

## 1. El Nodo HTTP Request
En tu flujo de n8n, solo necesitas **un solo nodo** de tipo "HTTP Request".

### Configuración del Nodo:
- **Method**: `POST`
- **URL**: `http://TU_IP_DROPLET:3032/chat`
- **Authentication**: None (o Header Auth si agregas seguridad después)
- **Send Body**: Activado
- **Body Parameters**:
  ```json
  {
    "message": "Revisa si hay backorders en la base de datos pedidosproduction",
    "history": [] 
  }
  ```

> **Truco Pro**: En el campo `message`, puedes inyectar variables de n8n (Expression), por ejemplo: `"Analiza el pedido con ID {{ $json.order_id }}"`.

## 2. Flujo Típico: "Alertas Automáticas"

Imagina un flujo que corre cada mañana:

1.  **Schedule Trigger**: "Cada día a las 8:00 AM".
2.  **HTTP Request (Tu MCP)**:
    *   Message: *"Ejecuta scan_backorders en la base de datos 'pedidosproduction' y dime si hay algo crítico."*
3.  **If (Condicional)**:
    *   Si la respuesta contiene "No hay backorders" -> Terminar.
    *   Si la respuesta detecta problemas -> Siguiente paso.
4.  **Slack / Email / WhatsApp**:
    *   Envía la respuesta de la IA (`{{ $json.response }}`) al canal de operaciones.

## 3. Flujo Conversacional (Chatbot)

Si estás construyendo un bot de soporte (ej. WhatsApp con Twilio en n8n):

1.  **Webhook (Recibe mensaje de WhatsApp)**.
2.  **HTTP Request (Tu MCP)**:
    *   Message: `{{ $json.body.message }}` (Lo que escribió el usuario).
    *   History: (Opcional) Si guardas el historial en una BD intermedia (Redis/Postgres), pásalo aquí.
3.  **Webhook Response**:
    *   Responde a WhatsApp con `{{ $json.response }}`.

---

### Ejemplo de Respuesta JSON que recibirás en n8n:

```json
{
  "response": "He escaneado la base de datos y encontré 5 backorders críticos...",
  "history": [ ... ]
}
```
