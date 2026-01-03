# Integración con Ollama y Swagger

Este documento explica las nuevas funcionalidades añadidas al servidor MCP de Analytics.

## 1. Validación con Ollama

Se ha actualizado el cliente de prueba (`src/openai_client.ts`) para soportar la validación con Ollama, permitiendo configurar la URL y la API Key mediante variables de entorno.

### Requisitos Previos

1.  Tener **Ollama** ejecutándose (localmente o en un servidor remoto).
2.  Tener un modelo que soporte **Function Calling** (Tools). Se recomienda **`llama3.1`**.
    ```bash
    ollama pull llama3.1
    ```

### Configuración

El archivo `.env` ha sido actualizado con las siguientes variables:

```ini
# Ollama Config
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_API_KEY=3a1369fd22684604b12c5d1dd05d14a7.j8AiT35aNmoL4fJq9fVdaACO
OLLAMA_MODEL=llama3.1
```

Si estás usando una instancia de Ollama que requiere autenticación (por ejemplo, a través de un proxy o túnel), asegúrate de establecer `OLLAMA_API_KEY` correctamente.

### Ejecutar la Validación

Para validar que el servidor MCP funciona correctamente con Ollama:

1.  Asegúrate de que el servidor MCP esté corriendo (o el script lo iniciará si se configura, pero actualmente el script cliente se conecta a uno existente).
    ```bash
    # En una terminal, inicia el servidor
    npm start
    ```
2.  En otra terminal, ejecuta el cliente de prueba:
    ```bash
    npm run test:client
    ```

El cliente:
1.  Se conectará al servidor MCP en `http://localhost:3032/sse`.
2.  Listará las herramientas disponibles.
3.  Enviará un prompt a Ollama (`Dime cuentos pedidos detalles tenemos hoy en pedidosproduccion`).
4.  Ollama solicitará el uso de herramientas si es necesario.
5.  El cliente ejecutará las herramientas en el servidor MCP y devolverá los resultados a Ollama.

## 2. Swagger UI

Se ha integrado **Swagger UI** para documentar los endpoints HTTP del servidor MCP.

### Acceso

Una vez iniciado el servidor (`npm start`), puedes acceder a la documentación interactiva en:

**http://localhost:3032/api-docs**

Esto mostrará los endpoints disponibles:
*   `GET /sse`: Endpoint para establecer la conexión Server-Sent Events.
*   `POST /messages`: Endpoint para enviar mensajes JSON-RPC.
