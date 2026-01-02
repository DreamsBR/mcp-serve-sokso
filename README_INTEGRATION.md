# Analytics MCP Integration

Este proyecto expone herramientas de análisis de datos a través del protocolo Model Context Protocol (MCP).

## Cómo consumir desde ms-pedidos (NestJS)

### 1. Instalación
En tu proyecto `ms-pedidos` (backend), instala el SDK:

```bash
npm install @modelcontextprotocol/sdk
```

### 2. Crear Servicio MCP
Crea un servicio en NestJS (ej. `mcp.service.ts`) para gestionar la conexión:

```typescript
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import * as path from 'path';

@Injectable()
export class McpService implements OnModuleInit, OnModuleDestroy {
  private client: Client;

  async onModuleInit() {
    // Ajusta la ruta al archivo build/index.js del servidor MCP
    const serverPath = path.resolve(process.cwd(), '../analytics-mcp/build/index.js');

    const transport = new StdioClientTransport({
      command: 'node',
      args: [serverPath],
    });

    this.client = new Client({ name: 'ms-pedidos', version: '1.0.0' }, { capabilities: {} });
    await this.client.connect(transport);
  }

  async runQuery(query: string) {
    // @ts-ignore
    const result = await this.client.request(CallToolResultSchema, {
      name: 'run_query',
      arguments: { query }
    });
    // @ts-ignore
    return JSON.parse(result.content[0].text);
  }
}
```

### 3. Uso
Inyecta `McpService` en tus controladores o servicios para ejecutar consultas y análisis.
