# Plan de Prueba con Integración OpenAI

Dado que hemos transformado el proyecto en un **Servidor MCP independiente** (que solo expone herramientas), la integración con OpenAI debe ocurrir en el lado del **Cliente**.

Para probar que tu API funciona correctamente conectada a OpenAI, crearé un script "Cliente Inteligente" que simulará ser tu aplicación (o un chatbot) consumiendo el servidor.

## Pasos de Implementación

1.  **Instalar Dependencias de Cliente**
    *   Instalaremos `openai` y `eventsource` (necesario para conectar por SSE desde Node.js) en el proyecto.

2.  **Crear Script de Prueba (`src/openai_client.ts`)**
    *   Este script se conectará a tu servidor local (`http://localhost:3030/sse`).
    *   Obtendrá la lista de herramientas disponibles (`inspect_schema`, `run_query`, etc.).
    *   Enviará un prompt de prueba a OpenAI (ej: "Analiza los backorders del 24 de diciembre").
    *   OpenAI decidirá qué herramientas usar.
    *   El script ejecutará esas herramientas en tu servidor MCP y devolverá los resultados a OpenAI.

3.  **Ejecutar la Prueba**
    *   Ejecutaremos el script para verificar el flujo completo: `Usuario -> OpenAI -> Tu Servidor MCP -> Base de Datos`.

## Requisitos
*   Asegúrate de que la variable `OPENAI_API_KEY` esté definida en tu archivo `.env`.

¿Te parece bien este enfoque para validar la integración sin ensuciar el código del servidor?