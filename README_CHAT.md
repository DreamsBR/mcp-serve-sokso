# Guía de Uso del Cliente Chat MCP

Una vez tu servidor MCP está corriendo en el Droplet (o localmente), puedes usar este cliente de chat para interactuar con él usando lenguaje natural.

## 1. Configuración
Asegúrate de tener tu `.env` configurado con:
```bash
# Opción 1: OpenAI
OPENAI_API_KEY=sk-tu-clave-openai...

# Opción 2: Google Gemini (Vertex AI)
GOOGLE_API_KEY=AQ.tu-clave-vertex...
GEMINI_MODEL=gemini-2.5-flash-lite

MCP_SERVER_URL=http://TU_IP_DROPLET:3032/sse
```

## 2. Ejecutar el Chat

### Para usar OpenAI:
```bash
npx tsx src/client-chat.ts
```

### Para usar Google Gemini (Vertex AI):
```bash
npx tsx src/client-chat-gemini.ts
```

## 3. Ejemplo de Interacción
```text
Tú: ¿Hay algún backorder en los pedidos recientes?
🤖 Pensando (Ejecutando herramientas)...
   > Ejecutando: scan_backorders
IA: Sí, encontré 3 backorders. Aquí están los detalles:
1. SKU: A123, Cantidad: 10, Comprometida: 5
...
```

## Nota para Integración Web
Si quieres integrar esto en una web (React/Angular):
1. El código de `src/client-chat.ts` debe ir en tu **Backend** (Node.js/NestJS).
2. El frontend solo envía el mensaje del usuario al backend.
3. El backend mantiene la sesión con OpenAI y llama al servidor MCP remoto.
